import { mkdtempSync, rmSync } from 'node:fs';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The folder under which each test file gets its tmux socket folder. */
    tmuxSocketsRoot: string;
  }
}

/**
 * Makes the folder that holds each test file's tmux socket folder (see
 * `tmux-sockets-setup.ts`), and removes it after the run, whatever became
 * of the files: one filtered out, or a worker ended early, runs no hook of
 * its own.
 *
 * The folder is under `/tmp` itself and its names are short, so that a
 * socket's path keeps within the 107 bytes Linux allows for the longest
 * socket name the cockpit makes, whatever the machine's `TMPDIR`.
 */
export default function setup(project: TestProject): () => void {
  const root = mkdtempSync('/tmp/ct-');
  project.provide('tmuxSocketsRoot', root);
  return () => rmSync(root, { recursive: true, force: true });
}
