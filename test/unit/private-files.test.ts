import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrivateFileOnce, writePrivateFile } from '../../src/server/state/private-files.ts';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-private-files-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('writePrivateFile', () => {
  it('writes a file only its user can read, even in place of a wider one', async () => {
    const path = join(folder, 'f');
    writeFileSync(path, 'old', { mode: 0o644 });
    await writePrivateFile(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(['f']);
  });
});

describe('createPrivateFileOnce', () => {
  it('creates the file when none is there, and gives its content', async () => {
    const path = join(folder, 'f');
    expect(await createPrivateFileOnce(path, 'mine')).toBe('mine');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps a file that is there, and gives its content', async () => {
    const path = join(folder, 'f');
    writeFileSync(path, 'first');
    expect(await createPrivateFileOnce(path, 'second')).toBe('first');
    expect(readFileSync(path, 'utf8')).toBe('first');
  });

  it('lets one of many racers win, and every one reads the winner’s content whole', async () => {
    const path = join(folder, 'f');
    const contents = Array.from({ length: 20 }, (_, i) => `content-${i}-${'x'.repeat(10_000)}`);
    const read = await Promise.all(contents.map((content) => createPrivateFileOnce(path, content)));
    expect(new Set(read).size).toBe(1);
    expect(contents).toContain(read[0]);
    expect(readdirSync(folder)).toEqual(['f']);
  });
});
