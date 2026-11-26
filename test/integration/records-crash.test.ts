import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openRecordStore } from '../../src/server/state/records.ts';

const WRITER = new URL('../support/record-writer.ts', import.meta.url).pathname;
const RUN_SOURCE = new URL('../support/run-source.mjs', import.meta.url).pathname;

let folder: string;
let writer: ChildProcessWithoutNullStreams | undefined;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-records-crash-'));
});

afterEach(async () => {
  if (writer && writer.exitCode === null && writer.signalCode === null) {
    const exited = once(writer, 'exit');
    writer.kill('SIGKILL');
    await exited;
  }
  writer = undefined;
  rmSync(folder, { recursive: true, force: true });
});

const asides = (records: string) => readdirSync(records).filter((name) => name !== 'a.json');

/** Resolves with the next line the writer prints `PUT <n>`, its n. */
function puts(child: ChildProcessWithoutNullStreams): () => Promise<number> {
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  return async () => {
    const { value, done } = await lines.next();
    if (done) throw new Error(`The record writer ended. ${errors}`);
    return Number(/^PUT (\d+)$/.exec(value)?.[1]);
  };
}

/**
 * Freezes the writer each time a file appears aside, and kills it there if
 * the file is still aside — a write cut short — else lets it go on.
 */
async function killMidWrite(child: ChildProcessWithoutNullStreams, records: string) {
  const watching = new AbortController();
  try {
    for await (const _ of watch(records, { signal: watching.signal })) {
      child.kill('SIGSTOP');
      if (asides(records).length > 0) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        return;
      }
      child.kill('SIGCONT');
    }
  } finally {
    watching.abort();
  }
}

it('keeps a whole record when the process dies in the middle of its write', async () => {
  const records = join(folder, 'records');
  writer = spawn(process.execPath, ['--import', RUN_SOURCE, WRITER, folder, 'a']);
  const nextPut = puts(writer);
  expect(await nextPut()).toBe(1);

  await killMidWrite(writer, records);
  expect(asides(records)).toHaveLength(1);

  const record = (await openRecordStore(folder)).get('a');
  if (record === undefined) throw new Error('The record put before the crash is gone.');
  const { round } = record.launchSettings as { round: number };
  expect(round).toBeGreaterThanOrEqual(1);
  expect(record.conversationId).toBe(`conversation-${round}`);
  expect(record.history).toHaveLength(20_000);
  expect(record.history.every((entry) => entry.conversationId === record.conversationId)).toBe(
    true,
  );
  expect(readdirSync(records)).toEqual(['a.json']);
});
