import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asideTarget,
  createPrivateFileOnce,
  writePrivateFile,
} from '../../src/server/state/private-files.ts';

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

  it('leaves nothing aside when it cannot put the file in place', async () => {
    mkdirSync(join(folder, 'taken'));
    writeFileSync(join(folder, 'taken', 'inside'), '');
    await expect(writePrivateFile(join(folder, 'taken'), 'new')).rejects.toThrow();
    expect(readdirSync(folder)).toEqual(['taken']);
  });
});

describe('asideTarget', () => {
  it('names the file an aside was written for', () => {
    expect(asideTarget('f.json.0b6f1c52-4bd5-4a53-9a0e-3c8e9c1f2d7a')).toBe('f.json');
  });

  it('names none for a file that is no aside', () => {
    expect(asideTarget('f.json')).toBeUndefined();
    expect(asideTarget('f.json.tmp')).toBeUndefined();
    expect(asideTarget('.0b6f1c52-4bd5-4a53-9a0e-3c8e9c1f2d7a')).toBeUndefined();
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
