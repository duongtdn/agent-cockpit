import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Gives each test file that runs tmux a socket folder of its own
 * (`TMUX_TMPDIR`), and fails the file if it leaves a socket there: a tmux
 * server still running, or the file a server that ended left behind. The
 * person's own sockets, under `/tmp/tmux-<uid>`, are never seen nor touched.
 *
 * The folder is under `/tmp` itself, short, so that a socket's path keeps
 * within the 107 bytes Linux allows, whatever the machine's `TMPDIR`.
 */
const folder = mkdtempSync('/tmp/cockpit-tmux-');
process.env.TMUX_TMPDIR = folder;
const sockets = join(folder, `tmux-${process.getuid?.()}`);

afterAll(() => {
  const left = socketsIn(sockets);
  for (const socket of left) endServer(join(sockets, socket));
  rmSync(folder, { recursive: true, force: true });
  if (left.length > 0) {
    throw new Error(`The test file left tmux sockets behind: ${left.join(', ')}.`);
  }
});

function socketsIn(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Ends a server still running on the socket, so that nothing outlives the run. */
function endServer(socket: string): void {
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // No server answers there: only its file was left.
  }
}
