import { join } from 'node:path';
import { beforeEach } from 'vitest';
import { beginTimeline, writeTimeline } from './timeline.ts';

/**
 * Keeps each test's timeline, and writes it when the test fails: the
 * screens and hooks of a red run, kept by CI as an artifact.
 */
const repository = join(import.meta.dirname, '..', '..');

beforeEach(({ task, onTestFailed }) => {
  beginTimeline();
  onTestFailed(() => {
    const path = writeTimeline(repository, task.file.filepath, task.fullName);
    if (path !== undefined) process.stderr.write(`The failed test's timeline: ${path}\n`);
  });
});
