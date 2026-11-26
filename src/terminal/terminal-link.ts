import type { Connection } from '../client/connection.js';
import { reconnectDelay } from '../client/reconnect-delay.js';
import { type CockpitError, isCockpitError } from '../shared/cockpit-error.js';
import {
  type KeyRule,
  SESSION_ENDED_CLOSE_CODE,
  type TerminalClientMessage,
  terminalPath,
} from '../shared/wire.js';

/** Where the terminal's connection to its session stands. */
export type TerminalStatus = 'connecting' | 'open' | 'closed' | 'ended';

/** A terminal's size, in character cells. */
export interface CellSize {
  readonly columns: number;
  readonly rows: number;
}

/** What the link asks of the terminal it serves. */
export interface LinkedScreen {
  /** The terminal's size now: sent first on every connection. */
  size(): CellSize;
  /** Shows what the session draws: its UTF-8 bytes. */
  write(output: Uint8Array): void;
  /** Told each status, as it changes. */
  status(status: TerminalStatus): void;
  /** Told why an attempt to connect failed, once per attempt. */
  failed(error: CockpitError): void;
}

/** A terminal's connection to its session, kept up until the session ends. */
export interface TerminalLink {
  /** The key rules of the session's driver; none until the server sent them. */
  keyRules(): readonly KeyRule[];
  /** Sends the person's input, as UTF-8; dropped while not connected. */
  sendInput(text: string): void;
  /** Sends input that is raw bytes, one per character (xterm's `onBinary`). */
  sendBytes(text: string): void;
  /** Tells the session the terminal's new size. */
  resize(size: CellSize): void;
  /** Closes the connection and stops reconnecting; the session goes on. */
  close(): void;
}

/**
 * Connects a terminal to its session over the wire's WebSocket: the size
 * first, as the server attaches at that size, then input and output as
 * binary messages. A close with {@link SESSION_ENDED_CLOSE_CODE} ends it;
 * any other close is the connection's, and the link reconnects, waiting
 * longer after each attempt that did not reach the session. A handshake
 * that failed is explained first (`Connection.explainFailedSocket`) and the
 * screen told why; when the terminal is off, the link stops: no attempt
 * can succeed until the app turns it on.
 *
 * @param connection - How the page reaches the cockpit.
 * @param key - The session's key: a valid one.
 * @param screen - The terminal served.
 * @returns The link, connecting.
 */
export function linkTerminal(
  connection: Connection,
  key: string,
  screen: LinkedScreen,
): TerminalLink {
  const path = terminalPath(key);
  const encoder = new TextEncoder();
  let rules: readonly KeyRule[] = [];
  let socket: WebSocket | undefined;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const sendWhenOpen = (data: string | Uint8Array<ArrayBuffer>): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(data);
  };
  const sendMessage = (message: TerminalClientMessage): void => {
    sendWhenOpen(JSON.stringify(message));
  };

  const reconnectLater = (): void => {
    retry = setTimeout(connect, reconnectDelay(failures));
    failures += 1;
  };

  const explainThenReconnect = async (): Promise<void> => {
    const error = await connection.explainFailedSocket(path);
    if (closed) return;
    screen.failed(error);
    if (isTerminalOff(error)) closed = true;
    else reconnectLater();
  };

  function connect(): void {
    screen.status('connecting');
    const current = connection.openSocket(path);
    current.binaryType = 'arraybuffer';
    socket = current;
    let opened = false;
    current.addEventListener('open', () => {
      opened = true;
      sendMessage({ type: 'resize', ...screen.size() });
      screen.status('open');
    });
    current.addEventListener('message', ({ data }: MessageEvent) => {
      if (data instanceof ArrayBuffer) {
        screen.write(new Uint8Array(data));
        return;
      }
      const sent = keyRulesOf(data);
      if (sent === undefined) return;
      // The server sends the rules once attached: the session was reached.
      rules = sent;
      failures = 0;
    });
    current.addEventListener('close', ({ code }: CloseEvent) => {
      if (closed) return;
      if (code === SESSION_ENDED_CLOSE_CODE) {
        closed = true;
        screen.status('ended');
        return;
      }
      screen.status('closed');
      if (opened) reconnectLater();
      else void explainThenReconnect();
    });
  }

  connect();
  return {
    keyRules: () => rules,
    sendInput: (text) => sendWhenOpen(encoder.encode(text)),
    sendBytes: (text) =>
      sendWhenOpen(Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff)),
    resize: (size) => sendMessage({ type: 'resize', ...size }),
    close: () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    },
  };
}

/**
 * Whether the terminal's switch refused it: off, or loopback-only to a
 * remote page. The app's configuration says so, and it holds until the app
 * changes it, so trying again would only repeat the refusal.
 */
function isTerminalOff(error: CockpitError): boolean {
  return isCockpitError(error, 'refused') && error.cause === 'terminal-off';
}

/**
 * The rules a `TerminalKeysMessage` carries; `undefined` for anything else,
 * which is skipped: client and server ship as one version.
 */
function keyRulesOf(data: unknown): readonly KeyRule[] | undefined {
  if (typeof data !== 'string') return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, rules } = message as { type?: unknown; rules?: unknown };
  return type === 'keys' && Array.isArray(rules) ? rules : undefined;
}
