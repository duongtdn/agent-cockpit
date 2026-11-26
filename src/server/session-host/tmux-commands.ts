import { appFileName } from '../app-name.js';
import type { TerminalSize } from './session-host.js';

/**
 * Marks a socket as a cockpit's, so that no app's name — `default`, say —
 * ever names the socket of the person's own tmux server.
 */
const SOCKET_PREFIX = 'agent-cockpit-';

/**
 * Derives the name of an app's tmux socket (`tmux -L`) from the app's name:
 * `agent-cockpit-`, then the app's file name ({@link appFileName}), 64
 * characters at most: longer, the socket's path would not fit a unix socket.
 * Two names do not share a socket — not even two that differ only by case.
 *
 * @param appName - The app's name, any string.
 * @returns The socket's name, of 64 characters at most.
 */
export function socketNameFor(appName: string): string {
  return `${SOCKET_PREFIX}${appFileName(appName)}`;
}

/**
 * The arguments every tmux command of the host begins with: the app's own
 * socket; no configuration file, so that the server behaves the same on every
 * machine, whatever the person's `~/.tmux.conf` sets; UTF-8, whatever the
 * locale of the app's server.
 *
 * @param socketName - The socket's name, from {@link socketNameFor}.
 */
export function connectionArguments(socketName: string): string[] {
  return ['-L', socketName, '-f', '/dev/null', '-u'];
}

/**
 * tmux takes `.` and `:` in a session's name for parts of a target and reads
 * `=`, `*` and others as patterns: a name is letters, digits, `-` and `_`.
 */
const SESSION_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Checks a session's name.
 *
 * @returns The name.
 * @throws `TypeError` for a name that is not letters, digits, `-` and `_`.
 */
export function checkedName(name: string): string {
  if (!SESSION_NAME.test(name)) {
    throw new TypeError(
      `A session's name is letters, digits, "-" and "_": ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/** The session and no other: without `=`, tmux also matches a prefix or a pattern. */
function sessionTarget(name: string): string {
  return `=${checkedName(name)}`;
}

/**
 * The pane the session was started with, by its place: a person attached with
 * their own tmux may split the window or open another, and the active pane
 * would then be theirs.
 */
function paneTarget(name: string): string {
  return `${sessionTarget(name)}:0.0`;
}

/** The tmux arguments that print a format for the session's own pane, and for no other. */
function paneFormatArguments(name: string, format: string): string[] {
  return ['list-panes', '-t', paneTarget(name), '-f', '#{==:#{pane_index},0}', '-F', format];
}

/**
 * The client's terminal type whose colors the host vouches for: the one the
 * host's own attached clients run with.
 */
export const CLIENT_TERMINAL_TYPE = 'xterm-256color';

/** `#`, `;`, line breaks and spaces would make the marker more than a word tmux prints as it is. */
const MARKER = /^[A-Za-z0-9-]+$/;

/**
 * The tmux arguments that start a session, in one call so that it is one
 * server from end to end: a server is started if none runs; it prints its
 * own variables, then a line that is the marker; then it reads the commands
 * of the start script, written from what it printed, on the standard
 * input. A command file has a grammar in which any argument can be quoted,
 * and no limit of length; tmux's own command line has neither (a final `;`
 * ends a command there, and a command is at most some 16 KiB). And what is
 * read on the standard input is in no process's arguments, where any user of
 * the machine could read it.
 *
 * @param marker - A word no variable's value ends a line with: letters,
 * digits and `-`.
 * @throws `TypeError` for a marker that is no such word.
 */
export function startArguments(marker: string): string[] {
  if (!MARKER.test(marker)) throw new TypeError(`Not a marker: ${JSON.stringify(marker)}`);
  return [
    'start-server',
    ';',
    'show-environment',
    '-g',
    ';',
    'display-message',
    '-p',
    marker,
    ';',
    'source-file',
    '-',
  ];
}

/**
 * Cuts a text into pieces of at most `length` characters, counted in code
 * points so that no character is cut in two.
 *
 * @throws `RangeError` when `length` is no whole number of one or more.
 */
export function chunkText(text: string, length: number): string[] {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`A write holds a whole number of characters, one or more: ${length}`);
  }
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let start = 0; start < characters.length; start += length) {
    chunks.push(characters.slice(start, start + length).join(''));
  }
  return chunks;
}

/**
 * A pane in copy-mode takes keys as commands of that mode, so every write
 * leaves it first, in the same tmux call. Leaving does nothing when the pane
 * is in no mode.
 */
function afterLeavingCopyMode(name: string, sendKeysArguments: readonly string[]): string[] {
  const pane = paneTarget(name);
  return ['copy-mode', '-q', '-t', pane, ';', 'send-keys', '-t', pane, ...sendKeysArguments];
}

/**
 * On tmux's command line a `;` that ends an argument ends the command, unless
 * written `\;`. How tmux reads backslashes before that `\;` differs between
 * versions, so a final `;` travels as a word of its own.
 */
function literalWords(chunk: string): string[] {
  if (!chunk.endsWith(';')) return [chunk];
  const before = chunk.slice(0, -1);
  return before === '' ? ['\\;'] : [before, '\\;'];
}

/**
 * The tmux arguments that type a text literally into a session's pane, one
 * list per write.
 *
 * @param chunkLength - The most characters in one write.
 */
export function textWrites(name: string, text: string, chunkLength: number): string[][] {
  return chunkText(text, chunkLength).map((chunk) =>
    afterLeavingCopyMode(name, ['-l', '--', ...literalWords(chunk)]),
  );
}

/**
 * The keys tmux knows by a name. tmux types a name it does not know as text,
 * so the host checks names before it sends them.
 */
const KEY =
  /^(?:[CM]-)*(?:Enter|Escape|Tab|BTab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|IC|DC|F[1-9]|F1[0-2])$/;

/**
 * One printable ASCII character with at least one modifier, as `C-u`. Not
 * `;`: at the end of a word it ends a tmux command, and how tmux reads one
 * escaped there differs between versions.
 */
const MODIFIED_CHARACTER = /^(?:[CM]-)+[!-:<-~]$/;

function checkedKey(key: string): string {
  if (!KEY.test(key) && !MODIFIED_CHARACTER.test(key)) {
    throw new TypeError(`Not a key the host knows by name: ${JSON.stringify(key)}`);
  }
  return key;
}

/**
 * The tmux arguments that press named keys in a session's pane.
 *
 * @throws `TypeError` for no key, or a name the host does not know.
 */
export function keyArguments(name: string, keys: readonly string[]): string[] {
  if (keys.length === 0) throw new TypeError('No key to press.');
  return afterLeavingCopyMode(name, keys.map(checkedKey));
}

/** Well under what one tmux command may hold, at three bytes for each. */
const BYTES_PER_WRITE = 1024;

/**
 * The tmux arguments that send bytes, as they are, to the program of a
 * session's pane; one list per tmux command.
 */
export function byteWrites(name: string, bytes: Uint8Array): string[][] {
  const writes: string[][] = [];
  for (let start = 0; start < bytes.length; start += BYTES_PER_WRITE) {
    const hex = Array.from(bytes.subarray(start, start + BYTES_PER_WRITE), (byte) =>
      byte.toString(16).padStart(2, '0'),
    );
    writes.push(afterLeavingCopyMode(name, ['-H', ...hex]));
  }
  return writes;
}

/**
 * The tmux arguments that read a session's screen: whether its pane is in a
 * mode, on a line, then the pane's visible rows. Read in one call, the two
 * describe the same moment.
 */
export function screenArguments(name: string): string[] {
  return [
    ...paneFormatArguments(name, '#{pane_in_mode}'),
    ';',
    'capture-pane',
    '-p',
    '-t',
    paneTarget(name),
  ];
}

/** The tmux arguments that list the names of the server's sessions. */
export const LIST_ARGUMENTS: readonly string[] = ['list-sessions', '-F', '#{session_name}'];

/** The tmux arguments that succeed when a session lives. */
export function liveArguments(name: string): string[] {
  return ['has-session', '-t', sessionTarget(name)];
}

/**
 * The tmux arguments that print the process id of a session's pane.
 * (`display-message` would print an empty line for a session that is gone;
 * `list-panes` fails.)
 */
export function processArguments(name: string): string[] {
  return paneFormatArguments(name, '#{pane_pid}');
}

/**
 * The tmux arguments that print one line for each client attached to a
 * session: the process id of the client, which is the process in its terminal.
 */
export function attachedArguments(name: string): string[] {
  return ['list-clients', '-t', sessionTarget(name), '-F', '#{client_pid}'];
}

/** The tmux arguments that kill a session. */
export function killArguments(name: string): string[] {
  return ['kill-session', '-t', sessionTarget(name)];
}

/** The tmux arguments of a client that attaches to a session; it runs in a pty. */
export function attachArguments(name: string): string[] {
  return ['attach-session', '-t', sessionTarget(name)];
}

/**
 * The tmux arguments that end the server: it prints its process id and the
 * path of its socket first, for the host to wait for the one and remove the
 * other. No server is started for it: where none runs, the call fails.
 */
export const SHUT_DOWN_ARGUMENTS: readonly string[] = [
  'display-message',
  '-p',
  '#{pid} #{socket_path}',
  ';',
  'kill-server',
];

/**
 * Checks the columns or the rows of a terminal.
 *
 * @param what - `columns` or `rows`, for the error's message.
 * @returns The number of cells.
 * @throws `RangeError` when it is no whole number of one or more.
 */
export function checkedCells(cells: number, what: string): number {
  if (!Number.isInteger(cells) || cells < 1) {
    throw new RangeError(`A terminal's ${what} are a whole number, one or more: ${cells}`);
  }
  return cells;
}

/** The size of a pty, as node-pty names it. */
export function ptySize(size: TerminalSize): { cols: number; rows: number } {
  return { cols: checkedCells(size.columns, 'columns'), rows: checkedCells(size.rows, 'rows') };
}
