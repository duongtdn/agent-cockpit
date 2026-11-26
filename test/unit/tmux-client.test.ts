import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTmuxClient } from '../../src/server/session-host/tmux-client.ts';
import { eventually } from '../support/eventually.ts';

let folder: string;
const restorations: (() => void)[] = [];

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-tmux-client-'));
});

afterEach(() => {
  for (const restore of restorations.splice(0)) restore();
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A program in tmux's place: a shell script that starts no server. */
function program(name: string, script: string, directory = folder): string {
  const executable = join(directory, name);
  writeFileSync(executable, `#!/bin/sh\n${script}\n`);
  chmodSync(executable, 0o755);
  return executable;
}

function clientOf(executable: string) {
  return createTmuxClient('agent-cockpit-client-test', executable, 5000);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sets the `PATH` of this process for the time of a test. */
function withPath(path: string): void {
  const before = process.env.PATH;
  process.env.PATH = path;
  restorations.push(() => {
    process.env.PATH = before;
  });
}

describe('a call that reads an answer to what it printed', () => {
  it('is given the answer once it has printed the marker, and what it printed is returned', async () => {
    const tmux = program('answered', 'echo one; echo marker; read line; echo "read: $line"');

    const printed = await clientOf(tmux).runAnswering([], 'marker', (before) =>
      before.toUpperCase(),
    );

    expect(printed).toBe('one\nmarker\nread: ONE\n');
  });

  it('fails with the error of an answer that cannot be written, and is ended', async () => {
    const pidFile = join(folder, 'refused.pid');
    const tmux = program('refused', `echo $$ > "${pidFile}"; echo marker; read line; sleep 30`);
    const refusal = new RangeError('no answer to that');

    const call = clientOf(tmux).runAnswering([], 'marker', () => {
      throw refusal;
    });

    await expect(call).rejects.toBe(refusal);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await eventually(() => expect(isRunning(pid)).toBe(false));
  });
});

describe('finding tmux for a call that runs without a PATH', () => {
  it('looks in the folders of the PATH, in order', async () => {
    const first = mkdtempSync(join(folder, 'first-'));
    const second = mkdtempSync(join(folder, 'second-'));
    program('cockpit-test-tmux', 'echo second; echo marker', second);
    withPath(`${first}:${second}`);

    const printed = await clientOf('cockpit-test-tmux').runAnswering([], 'marker', () => '');

    expect(printed).toBe('second\nmarker\n');
  });

  it('never looks in the current folder for an empty entry of the PATH', async () => {
    const current = mkdtempSync(join(folder, 'current-'));
    program('cockpit-test-tmux', 'echo current; echo marker', current);
    const before = process.cwd();
    process.chdir(current);
    restorations.push(() => process.chdir(before));
    withPath(`:${join(folder, 'nowhere')}:`);

    const call = clientOf('cockpit-test-tmux').runAnswering([], 'marker', () => '');

    await expect(call).rejects.toMatchObject({ kind: 'not-installed' });
  });
});
