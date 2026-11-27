import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import { callEach } from '../client/app-handlers.js';
import { createConnection } from '../client/connection.js';
import { takeTokenFromLink } from '../client/token.js';
import { CockpitError } from '../shared/cockpit-error.js';
import { isSessionKey, SESSION_KEY_MAX_LENGTH } from '../shared/session.js';
import { clipboardTextOf, writeClipboard } from './clipboard.js';
import { ruleForKey } from './key-rules.js';
import { linkTerminal, type TerminalLink, type TerminalStatus } from './terminal-link.js';

/** The OSC number by which a program asks the terminal to set the clipboard. */
const CLIPBOARD_SEQUENCE = 52;

/** What `mountTerminal` takes. */
export interface MountTerminalOptions {
  /**
   * Where the app mounted the cockpit's handler: a path (`/cockpit`), resolved
   * against the page's address, or an `http:` or `https:` URL.
   */
  readonly baseUrl: string;
  /** The terminal's colors, as xterm.js names them. */
  readonly theme?: ITheme;
  /** The terminal's font, as CSS names it. */
  readonly fontFamily?: string;
  /** The font's size, in CSS pixels. */
  readonly fontSize?: number;
}

/** A terminal mounted in the app's element. */
export interface MountedTerminal {
  /**
   * Follows the connection's status: `connecting`, `open`, `held` (open,
   * while the cockpit types a prompt into the session: what the person
   * types is kept by the server and reaches the session after the send, in
   * order; then `open` again), `closed` (the
   * connection dropped or was refused; the terminal reconnects by itself,
   * unless the terminal's switch refused it: then it stays `closed`) or
   * `ended` (the session is gone: nothing to attach to). The handler
   * receives the status at once, then each change. A handler that throws
   * stops neither the other handlers nor the terminal; what it threw goes
   * to the console.
   *
   * @param event - `'status'`.
   * @param handler - Receives each status.
   * @returns A function that removes the handler.
   */
  on(event: 'status', handler: (status: TerminalStatus) => void): () => void;
  /**
   * Tells why the terminal could not connect, once per failed attempt,
   * after the client's `on('error')`: the server's refusal, explained by an
   * HTTP request to the terminal's path that the same checks and the
   * terminal's switch refuse the same way — `refused` with its `cause`
   * (`terminal-off` among them), or `no-token` — or `unreachable`: nothing
   * answers, the answer breaks off as it is read, what answers is not the
   * cockpit, or the checks pass and still no WebSocket opened (a proxy
   * between may not pass them). A connection that drops and reconnects is
   * not reported, nor a handshake the server asked to be made again (a
   * renewal of the app's token overlapped it). On `terminal-off` the
   * terminal stops trying: the app's switch refuses it until the app
   * changes it, and a new mount connects then. A handler that throws stops
   * neither the other handlers nor the reconnection; what it threw goes to
   * the console.
   *
   * @param event - `'error'`.
   * @param handler - Receives each error.
   * @returns A function that removes the handler.
   */
  on(event: 'error', handler: (error: CockpitError) => void): () => void;
  /** Gives the terminal the keyboard. */
  focus(): void;
  /**
   * Closes the connection and removes the terminal from the element. The
   * session goes on; it can be mounted again.
   */
  dispose(): void;
}

/**
 * Mounts a session's terminal in an element: an xterm.js terminal of the
 * cockpit's own, fitted to the element and following its size, attached to
 * the session over a WebSocket that carries the app's token (taken from the
 * page's link as the client takes it). After a drop it reconnects by itself,
 * waiting 0.5 s, doubling up to 10 s, and at once when a link opened in the
 * page's tab gives a new token; once the session has ended it stays
 * `ended`. Why it could not connect goes to `on('error')`; refused by the
 * terminal's switch (`terminal-off`), it stays `closed`.
 * While the cockpit types a prompt into the session it is `held`.
 *
 * Keys: the session's driver sends its key rules when the terminal attaches
 * (for Claude Code, Shift+Enter types a new line rather than submitting).
 * Copy: text the session copies (the agent's own selection, tmux's) reaches
 * the clipboard; a selection of the terminal's own, made with Shift+drag
 * (Option+drag on macOS), is copied by Ctrl+C, which then sends nothing to
 * the session. The page links xterm.js's style sheet,
 * `@xterm/xterm/css/xterm.css`.
 *
 * @param element - Where the terminal lives; the app owns its size.
 * @param key - The session's key.
 * @param options - See {@link MountTerminalOptions}.
 * @returns The mounted terminal.
 * @throws `CockpitError` `invalid-options` when `key` is no session key or
 * `baseUrl` is not a path or an HTTP URL.
 */
export function mountTerminal(
  element: HTMLElement,
  key: string,
  options: MountTerminalOptions,
): MountedTerminal {
  checkKey(key);
  const connection = createConnection(options.baseUrl, takeTokenFromLink());
  const terminal = new Terminal({
    ...looks(options),
    // On macOS, Option forces the terminal's own selection over the mouse reports the agent asks for.
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  fit.fit();

  const statuses = statusEmitter();
  const errors = new Set<(error: CockpitError) => void>();
  const link = linkTerminal(connection, key, {
    size: () => ({ columns: terminal.cols, rows: terminal.rows }),
    write: (output) => terminal.write(output),
    status: statuses.emit,
    failed: (error) => callEach(errors, error),
  });
  const subscriptions = [
    terminal.onData((text) => link.sendInput(text)),
    terminal.onBinary((text) => link.sendBytes(text)),
    terminal.onResize(({ cols, rows }) => link.resize({ columns: cols, rows })),
    terminal.parser.registerOscHandler(CLIPBOARD_SEQUENCE, (data) => {
      const text = clipboardTextOf(data);
      if (text !== undefined) writeClipboard(text);
      return true;
    }),
  ];
  terminal.attachCustomKeyEventHandler((event) => handleKey(event, terminal, link));
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(element);

  function on(event: 'status', handler: (status: TerminalStatus) => void): () => void;
  function on(event: 'error', handler: (error: CockpitError) => void): () => void;
  function on(event: 'status' | 'error', handler: Handler): () => void {
    // The overloads tie each event to its handler: the event tells which this is.
    return event === 'status'
      ? statuses.subscribe(handler as (status: TerminalStatus) => void)
      : subscribe(errors, handler as (error: CockpitError) => void);
  }

  let disposed = false;
  return {
    on,
    focus: () => terminal.focus(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      statuses.clear();
      errors.clear();
      observer.disconnect();
      link.close();
      for (const subscription of subscriptions) subscription.dispose();
      terminal.dispose();
    },
  };
}

function checkKey(key: string): void {
  if (typeof key === 'string' && isSessionKey(key)) return;
  throw new CockpitError('invalid-options', 'The terminal needs a session key.', {
    issues: [
      {
        path: ['key'],
        message: `Expected a session key: [a-z0-9-]+, ${SESSION_KEY_MAX_LENGTH} characters at most.`,
      },
    ],
  });
}

/** The look options xterm.js takes, without those the app left out. */
function looks({ theme, fontFamily, fontSize }: MountTerminalOptions): {
  theme?: ITheme;
  fontFamily?: string;
  fontSize?: number;
} {
  return {
    ...(theme === undefined ? {} : { theme }),
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(fontSize === undefined ? {} : { fontSize }),
  };
}

/**
 * Decides who handles a key: `false` when the terminal took it (xterm.js
 * then sends nothing), `true` to leave it to xterm.js. The browser delivers
 * a key as `keydown` and, for some, `keypress` too: what it sends is sent
 * on `keydown` only, and the `keypress` of a key taken is taken as well.
 */
function handleKey(event: KeyboardEvent, terminal: Terminal, link: TerminalLink): boolean {
  const pressed = event.type === 'keydown';
  if (pressed && isCopyKey(event) && terminal.hasSelection()) {
    writeClipboard(terminal.getSelection());
    terminal.clearSelection();
    event.preventDefault();
    return false;
  }
  const rule = ruleForKey(link.keyRules(), event);
  if (rule === undefined) return true;
  if (pressed) link.sendInput(rule.send);
  event.preventDefault();
  return false;
}

/** Ctrl+C alone: with a selection of the terminal's own, it copies instead of interrupting. */
function isCopyKey(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === 'c' &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  );
}

/** A handler of either event of the mounted terminal. */
type Handler = ((status: TerminalStatus) => void) | ((error: CockpitError) => void);

/**
 * Adds a handler to a set; a handler given twice is two subscriptions, each
 * removed by its own function.
 */
function subscribe<T>(handlers: Set<(value: T) => void>, handler: (value: T) => void): () => void {
  const subscription = (value: T): void => handler(value);
  handlers.add(subscription);
  return () => {
    handlers.delete(subscription);
  };
}

/** The status handlers and the status they last heard. */
function statusEmitter(): {
  emit(status: TerminalStatus): void;
  subscribe(handler: (status: TerminalStatus) => void): () => void;
  clear(): void;
} {
  const handlers = new Set<(status: TerminalStatus) => void>();
  let current: TerminalStatus = 'connecting';
  return {
    emit: (status) => {
      current = status;
      callEach(handlers, status);
    },
    subscribe: (handler) => {
      const stop = subscribe(handlers, handler);
      callEach([handler], current);
      return stop;
    },
    clear: () => handlers.clear(),
  };
}
