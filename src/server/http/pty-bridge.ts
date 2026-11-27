import type { RawData, WebSocket } from 'ws';
import {
  FELL_BEHIND_CLOSE_CODE,
  type KeyRule,
  SESSION_ENDED_CLOSE_CODE,
  type TerminalResizeMessage,
  type TerminalServerMessage,
} from '../../shared/wire.js';
import type { Attachment, TerminalSize } from '../session-host/session-host.js';
import type { HeldTerminal } from '../terminal-hold.js';

/** What the bridge reaches a session through. */
export interface BridgedSessions {
  /**
   * Attaches a terminal to a live session: the sessions core's `attach`.
   *
   * @returns `undefined` when no session of the key lives.
   */
  attach(key: string, size: TerminalSize): Promise<Attachment | undefined>;
  /** Tells whether the session still lives on the host. */
  isLive(key: string): Promise<boolean>;
  /**
   * Joins an attached terminal to its session's key hold: the
   * `TerminalHolds`' `join`.
   *
   * @returns Its removal.
   */
  joinHold(key: string, terminal: HeldTerminal): () => void;
}

/**
 * The most bytes a terminal's socket may still hold to send before it is
 * closed as fallen behind: far more than the agent draws (a screenful is a
 * few kilobytes, a long reply some tens), and a bound on what a page that
 * stopped reading costs the server.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** The close code of a socket whose first message was not the terminal's size. */
const POLICY_VIOLATION = 1008;

/** The close code of a socket the server could not serve: the terminal reconnects. */
const SERVER_ERROR = 1011;

/**
 * The largest side of a terminal taken, in cells: far beyond any screen, and
 * small enough that no page makes tmux hold an absurd window.
 */
const MAX_CELLS = 1000;

/**
 * The longest wait between two kept keys as they are written to the
 * session, in milliseconds: written at once, the person's keys would come
 * as one burst, which the agent can take for a paste; the driver's own
 * typing is read as typing at this pace.
 */
const KEPT_KEYS_GAP_MS = 50;

/**
 * The most a terminal's kept keys may weigh, in UTF-8 bytes: a person types
 * far less during a send, even pasting; a terminal that sends more is
 * closed rather than held in memory.
 */
const MAX_KEPT_BYTES = 1024 * 1024;

/**
 * Bridges a terminal's WebSocket to its session (the pty bridge): waits for
 * the terminal's size, its first message, attaches the session at that
 * size, sends the driver's key rules, then passes what the session draws
 * out as binary messages and the person's keys in, and applies each later
 * size. What the session draws in one turn of the event loop goes as one
 * message; a socket that still holds more than {@link MAX_BUFFERED_BYTES}
 * to send is closed with {@link FELL_BEHIND_CLOSE_CODE} instead, the
 * session untouched. While the cockpit types a prompt into the session
 * (the session's key held), the person's keys are kept, the browser told
 * `held`; once released, they reach the session in the order sent, each
 * as it was sent, at most {@link KEPT_KEYS_GAP_MS} apart, then the browser
 * is told `released`. Kept keys over {@link MAX_KEPT_BYTES} close the
 * socket (1008); a socket that closes drops its kept keys. When the session
 * ends, the socket closes with {@link SESSION_ENDED_CLOSE_CODE}, and so it
 * does at once when no session of the key lives; when the socket closes,
 * the terminal detaches and the session goes on.
 *
 * @param socket - The terminal's WebSocket, open.
 * @param key - The session's key.
 * @param sessions - Where the session is reached.
 * @param keyRules - The driver's terminal keys.
 * @returns A promise fulfilled once the bridge is over: the socket closed
 * and the terminal, if one was attached, detached.
 */
export function bridgeTerminal(
  socket: WebSocket,
  key: string,
  sessions: BridgedSessions,
  keyRules: readonly KeyRule[],
): Promise<void> {
  let attachment: Attachment | undefined;
  let attaching: Promise<void> | undefined;
  let gate: KeyGate | undefined;
  let leaveHold = (): void => {};
  const early: RawData[] = [];

  const take = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      gate?.pass(textOf(data));
      return;
    }
    const size = sizeOf(data);
    if (size !== undefined) attachment?.resize(size);
  };

  const tell = (message: TerminalServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  const attach = async (size: TerminalSize): Promise<void> => {
    let attached: Attachment | undefined;
    try {
      attached = await sessions.attach(key, size);
    } catch {
      socket.close(SERVER_ERROR, 'The session could not be attached.');
      return;
    }
    if (attached === undefined) {
      socket.close(SESSION_ENDED_CLOSE_CODE, 'The session has ended.');
      return;
    }
    attachment = attached;
    if (socket.readyState !== socket.OPEN) return;
    tell({ type: 'keys', rules: keyRules });
    attached.onData(outputSender(socket));
    attached.onEnd(() => void closeOnEnd(socket, key, sessions));
    gate = keyGate(
      (text) => attached.write(text),
      tell,
      () => socket.close(POLICY_VIOLATION, 'Too many keys sent while the session was held.'),
    );
    leaveHold = sessions.joinHold(key, gate);
    for (const data of early.splice(0)) gate.pass(textOf(data));
  };

  socket.on('message', (data, isBinary) => {
    if (attaching === undefined) {
      const size = isBinary ? undefined : sizeOf(data);
      if (size === undefined) {
        socket.close(POLICY_VIOLATION, "The first message is the terminal's size.");
        return;
      }
      attaching = attach(size);
    } else if (attachment === undefined) {
      // Keys typed while the session attaches reach it once it has.
      if (isBinary) early.push(data);
    } else {
      take(data, isBinary);
    }
  });

  return new Promise((resolve) => {
    socket.once('close', () => {
      leaveHold();
      gate?.drop();
      void (async () => {
        await attaching;
        await attachment?.detach();
        resolve();
      })();
    });
  });
}

/** A terminal's keys on their way to the session, kept while its key is held. */
interface KeyGate extends HeldTerminal {
  /** Passes the person's keys on, or keeps them while held or while kept keys are still written. */
  pass(text: string): void;
  /** Drops the kept keys: the terminal is gone. */
  drop(): void;
}

/**
 * Makes a terminal's key gate.
 *
 * @param write - Writes keys to the session.
 * @param tell - Sends the browser a message.
 * @param overflow - Called when the kept keys outgrow {@link MAX_KEPT_BYTES}.
 */
function keyGate(
  write: (text: string) => void,
  tell: (message: TerminalServerMessage) => void,
  overflow: () => void,
): KeyGate {
  const kept: { text: string; at: number }[] = [];
  let keptBytes = 0;
  let held = false;
  // Outlasts the hold until the keys kept are written: a key typed in
  // between must not overtake them.
  let keeping = false;
  let discarded = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const stopKeeping = (): void => {
    keeping = false;
    tell(discarded ? { type: 'released', discarded: true } : { type: 'released' });
    discarded = false;
  };

  const dropKept = (): void => {
    clearTimeout(pending);
    pending = undefined;
    kept.length = 0;
    keptBytes = 0;
  };

  const writeNext = (): void => {
    pending = undefined;
    if (held) return;
    const next = kept.shift();
    if (next !== undefined) {
      keptBytes -= Buffer.byteLength(next.text);
      write(next.text);
    }
    const following = kept[0];
    if (next === undefined || following === undefined) {
      stopKeeping();
      return;
    }
    pending = setTimeout(writeNext, Math.min(following.at - next.at, KEPT_KEYS_GAP_MS));
  };

  return {
    pass(text) {
      if (!keeping) {
        write(text);
        return;
      }
      const bytes = Buffer.byteLength(text);
      if (keptBytes + bytes > MAX_KEPT_BYTES) {
        overflow();
        return;
      }
      keptBytes += bytes;
      kept.push({ text, at: Date.now() });
    },
    hold() {
      held = true;
      clearTimeout(pending);
      pending = undefined;
      if (keeping) return;
      keeping = true;
      tell({ type: 'held' });
    },
    release() {
      held = false;
      if (pending === undefined) writeNext();
    },
    discard() {
      if (kept.length === 0) return;
      discarded = true;
      dropKept();
      if (!held) stopKeeping();
    },
    drop: dropKept,
  };
}

/**
 * Gives what passes the session's output to the socket. Under a flood the
 * pty hands over thousands of chunks of a few bytes a second, and each
 * message the socket holds costs many times its bytes: the chunks that
 * arrive in one turn of the event loop are joined, which delays a key's
 * echo by that turn alone. A socket still holding more than
 * {@link MAX_BUFFERED_BYTES} is closed rather than given more: the server
 * would hold the session's output for a page that does not read it.
 */
function outputSender(socket: WebSocket): (data: string) => void {
  let pending: string[] = [];
  const flush = (): void => {
    const output = pending.join('');
    pending = [];
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(FELL_BEHIND_CLOSE_CODE, 'The terminal fell behind the session.');
      return;
    }
    socket.send(Buffer.from(output, 'utf8'));
  };
  return (data) => {
    if (pending.length === 0) setImmediate(flush);
    pending.push(data);
  };
}

/** Closes the socket of an attachment that ended without being detached. */
async function closeOnEnd(socket: WebSocket, key: string, sessions: BridgedSessions) {
  if (socket.readyState !== socket.OPEN) return;
  const live = await sessions.isLive(key).catch(() => true);
  if (live) socket.close(SERVER_ERROR, 'The terminal was detached.');
  else socket.close(SESSION_ENDED_CLOSE_CODE, 'The session has ended.');
}

function textOf(data: RawData): string {
  return bufferOf(data).toString('utf8');
}

function bufferOf(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** The size a resize message carries; `undefined` for anything else. */
function sizeOf(data: RawData): TerminalSize | undefined {
  let message: Partial<TerminalResizeMessage>;
  try {
    message = JSON.parse(textOf(data));
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null || message.type !== 'resize') {
    return undefined;
  }
  const { columns, rows } = message;
  return isCells(columns) && isCells(rows) ? { columns, rows } : undefined;
}

function isCells(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_CELLS;
}
