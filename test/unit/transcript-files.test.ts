import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTranscript } from '../support/transcript-files.ts';

const ID = '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11';
let configFolder: string;

beforeEach(() => {
  configFolder = mkdtempSync(join(tmpdir(), 'cockpit-transcript-files-'));
});

afterEach(() => {
  rmSync(configFolder, { recursive: true, force: true });
});

describe('the transcript of a conversation', () => {
  it('is found by its session, whatever project folder holds it (behavior 3)', () => {
    const project = join(configFolder, 'projects', '-work-unit');
    mkdirSync(join(configFolder, 'projects', '-work-other'), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${ID}.jsonl`), '');

    expect(findTranscript(configFolder, ID)).toBe(join(project, `${ID}.jsonl`));
  });

  it('is not found for a session that recorded nothing, or a folder with no project', () => {
    mkdirSync(join(configFolder, 'projects', '-work-unit'), { recursive: true });

    expect(findTranscript(configFolder, ID)).toBeUndefined();
    expect(findTranscript(join(configFolder, 'absent'), ID)).toBeUndefined();
  });
});
