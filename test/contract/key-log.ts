import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Between two arguments of one write, and after each write, in the log: neither can be typed. */
const ARGUMENT_END = '\x1f';
const WRITE_END = '\x1e';

/**
 * A log of the writes a server's process makes into its tmux sessions:
 * a `tmux` first on that process's `PATH` that notes the arguments of each
 * `send-keys` (the host's keys, text and bytes alike), then runs the real
 * one with the same arguments.
 */
export interface KeyLog {
  /** The folder that holds the logging `tmux`, to put on the server's `PATH`. */
  readonly folder: string;
  /** The real `tmux`, for the test's own keys, which the log leaves out. */
  readonly realTmux: string;
  /** Every write logged so far, in order: the arguments of each `send-keys`. */
  writes(): string[][];
}

/**
 * Makes a key log in a folder of the run's.
 *
 * @param root - The run's temporary root, which holds the log and its `tmux`.
 * @returns The log, empty.
 * @throws Error when no `tmux` is on the `PATH`.
 */
export function startKeyLog(root: string): KeyLog {
  const realTmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  const folder = join(root, 'key-log');
  const log = join(folder, 'writes');
  mkdirSync(folder);
  writeFileSync(log, '');
  const script = join(folder, 'tmux');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'for argument; do',
      '  if [ "$argument" = send-keys ]; then',
      `    { printf '%s${ARGUMENT_END}' "$@"; printf '${WRITE_END}'; } >> '${log}'`,
      '    break',
      '  fi',
      'done',
      `exec '${realTmux}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return {
    folder,
    realTmux,
    writes: () =>
      readFileSync(log, 'utf8')
        .split(WRITE_END)
        .filter((write) => write !== '')
        .map((write) => write.split(ARGUMENT_END).slice(0, -1)),
  };
}
