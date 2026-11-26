import type { RawData, WebSocket } from 'ws';
import {
  type KeyRule,
  SESSION_ENDED_CLOSE_CODE,
  type TerminalKeysMessage,
  type TerminalResizeMessage,
} from '../../shared/wire.js';
import type { Attachment, TerminalSize } from '../session-host/session-host.js';

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
}

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
 * Bridges a terminal's WebSocket to its session (the pty bridge): waits for
 * the terminal's size, its first message, attaches the session at that
 * size, sends the driver's key rules, then passes what the session draws
 * out as binary messages and the person's keys in, and applies each later
 * size. When the session ends, the socket closes with
 * {@link SESSION_ENDED_CLOSE_CODE}, and so it does at once when no session
 * of the key lives; when the socket closes, the terminal detaches and the
 * session goes on.
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
  const early: RawData[] = [];

  const take = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      attachment?.write(textOf(data));
      return;
    }
    const size = sizeOf(data);
    if (size !== undefined) attachment?.resize(size);
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
    const keys: TerminalKeysMessage = { type: 'keys', rules: keyRules };
    socket.send(JSON.stringify(keys));
    attached.onData((data) => socket.send(Buffer.from(data, 'utf8')));
    attached.onEnd(() => void closeOnEnd(socket, key, sessions));
    for (const data of early.splice(0)) attachment.write(textOf(data));
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
      void (async () => {
        await attaching;
        await attachment?.detach();
        resolve();
      })();
    });
  });
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
