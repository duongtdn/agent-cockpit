import type { Screen, SessionProcess } from './session-host.js';
import { SessionHostError } from './session-host-error.js';

/**
 * What a failed tmux command means to the host:
 *
 * - `no-server`: no tmux server runs on the socket, so no session lives;
 * - `no-session`: the server runs, the session named does not live;
 * - `duplicate-session`: a session of that name lives already;
 * - `other`: anything else.
 */
export type TmuxFailureKind = 'no-server' | 'no-session' | 'duplicate-session' | 'other';

/**
 * tmux has no exit status per kind of failure: its message tells. A server
 * that exits while a command reaches it (its last session just ended) is no
 * server either, and one that still runs with no session left answers that
 * no target lives. A socket that cannot be reached for another reason — a path
 * too long, a folder that is someone else's — is no answer about sessions:
 * it is the host's failure.
 */
const FAILURES: readonly (readonly [RegExp, TmuxFailureKind])[] = [
  [/^(no server running on |server exited unexpectedly)/, 'no-server'],
  [/^error connecting to .* \((No such file or directory|Connection refused)\)$/m, 'no-server'],
  [/^can't find (session|window|pane)/, 'no-session'],
  // What a server with no session left answers a target, its last one just ended (seen on 3.2a).
  [/^no current target$/m, 'no-session'],
  [/^duplicate session: /, 'duplicate-session'],
];

/**
 * Reads what a failed tmux command means from what it printed.
 *
 * @param stderr - The command's error output.
 */
export function classifyFailure(stderr: string): TmuxFailureKind {
  return FAILURES.find(([message]) => message.test(stderr))?.[1] ?? 'other';
}

/**
 * Reads the path of a socket no server listens on any more from what a
 * failed tmux command printed: a server that ends leaves its socket's file.
 *
 * @param stderr - The command's error output.
 * @returns The path, or `undefined` when tmux named no such socket.
 */
export function socketLeftBehind(stderr: string): string | undefined {
  return (
    /^no server running on (.+)$/m.exec(stderr)?.[1] ??
    /^error connecting to (.+) \(Connection refused\)$/m.exec(stderr)?.[1]
  );
}

/**
 * Tells whether a failed tmux command met a server that exited under it: tmux
 * then names no socket, and asking again finds the server gone and names it.
 *
 * @param stderr - The command's error output.
 */
export function serverExitedUnder(stderr: string): boolean {
  return /^server exited unexpectedly/m.test(stderr);
}

/** Splits tmux's output into its lines, without the empty ones. */
export function parseLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line !== '');
}

function unexpected(what: string, stdout: string): SessionHostError {
  return new SessionHostError(
    'host-failed',
    `tmux printed an unexpected ${what}: ${JSON.stringify(stdout.slice(0, 200))}`,
  );
}

/**
 * Reads a screen from the output of the host's screen command: the pane's
 * mode flag on the first line, then the visible rows.
 *
 * @throws `SessionHostError` `host-failed` when the output does not begin with the flag.
 */
export function parseScreen(stdout: string): Screen {
  const match = /^([01])\n(.*)$/s.exec(stdout);
  if (match === null) throw unexpected('screen', stdout);
  const [, flag, rows = ''] = match;
  return { inCopyMode: flag === '1', text: rows.replace(/\n$/, '') };
}

/**
 * Reads the process of a session's pane from its process id on a line.
 *
 * @throws `SessionHostError` `host-failed` when the output is no process id.
 */
export function parseProcess(stdout: string): SessionProcess {
  const match = /^([1-9]\d*)\n$/.exec(stdout);
  if (match === null) throw unexpected('process id', stdout);
  return { pid: Number(match[1]) };
}

/**
 * Reads the names of a server's variables from what `show-environment -g`
 * printed: `NAME=value` a line, `-NAME` for one marked as removed. A value of
 * several lines gives lines that may read as names too: the host only ever
 * removes these names from a session, and removing one that is not there
 * does nothing.
 *
 * @returns The names, in order; a name may come twice.
 */
export function parseVariableNames(stdout: string): string[] {
  return parseLines(stdout)
    .map(variableNameOf)
    .filter((name) => name !== '' && !name.includes('='));
}

function variableNameOf(line: string): string {
  if (line.startsWith('-')) return line.slice(1);
  const end = line.indexOf('=');
  return end === -1 ? '' : line.slice(0, end);
}

/** A tmux server: its process and the socket it listens on. */
export interface TmuxServer {
  /** The server's process id. */
  readonly pid: number;
  /** The path of the server's socket. */
  readonly socketPath: string;
}

/**
 * Reads a server from its process id and its socket's path on a line.
 *
 * @throws `SessionHostError` `host-failed` when the output is no such line.
 */
export function parseServer(stdout: string): TmuxServer {
  const match = /^([1-9]\d*) (.+)\n$/.exec(stdout);
  if (match === null) throw unexpected('server line', stdout);
  const [, pid, socketPath = ''] = match;
  return { pid: Number(pid), socketPath };
}
