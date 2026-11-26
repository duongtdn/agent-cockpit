import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  projectFolderName,
  SEARCH_BACKOFF_MS,
  transcriptSearch,
} from '../../src/claude-code/conversations.ts';

const CONVERSATION = '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11';

let root: string;
let configFolder: string;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-transcript-search-'));
  configFolder = join(root, 'config');
  clock = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes the conversation's transcript in a project folder of the configuration folder. */
function writeTranscriptIn(project: string): string {
  const folder = join(configFolder, 'projects', project);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${CONVERSATION}.jsonl`);
  writeFileSync(path, '{}\n');
  return path;
}

function searchFor(directory: string) {
  return transcriptSearch({ configFolder, conversationId: CONVERSATION, directory }, () => clock);
}

describe("the project folder Claude Code keeps a work folder's conversations in", () => {
  it('is named after the folder, every character but a letter or a digit a dash', () => {
    expect(projectFolderName('/work/my_app.v2')).toBe('-work-my-app-v2');
  });

  it('has no name the driver can make beyond 200 characters, where Claude Code adds a hash', () => {
    expect(projectFolderName(`/${'a'.repeat(199)}`)).toHaveLength(200);
    expect(projectFolderName(`/${'a'.repeat(200)}`)).toBeUndefined();
  });
});

describe("a search for a conversation's transcript", () => {
  it("looks in the work folder's project folder at every round", async () => {
    const search = searchFor('/work/app');
    expect(await search()).toBeUndefined();

    const path = writeTranscriptIn('-work-app');

    expect(await search()).toBe(path);
  });

  it("looks in the project folder of the work folder's real path too", async () => {
    mkdirSync(join(root, 'real-app'));
    symlinkSync(join(root, 'real-app'), join(root, 'linked-app'));
    const search = searchFor(join(root, 'linked-app'));
    expect(await search()).toBeUndefined();

    const path = writeTranscriptIn(projectFolderName(join(root, 'real-app')) as string);

    expect(await search()).toBe(path);
  });

  it('looks in every project folder at once, then on a slower back-off, never every round', async () => {
    const [first, second] = SEARCH_BACKOFF_MS;
    const search = searchFor('/work/app');
    expect(await search()).toBeUndefined();
    const path = writeTranscriptIn('-elsewhere-app');

    clock = (first as number) - 1;
    expect(await search()).toBeUndefined();
    clock = first as number;
    expect(await search()).toBe(path);

    rmSync(join(configFolder, 'projects'), { recursive: true });
    clock = 0;
    const later = searchFor('/work/app');
    await later();
    clock = first as number;
    await later();
    writeTranscriptIn('-elsewhere-app');
    clock = (first as number) + (second as number) - 1;
    expect(await later()).toBeUndefined();
    clock = (first as number) + (second as number);
    expect(await later()).toBe(path);
  });

  it('waits no longer than the last step of its back-off between two searches of every folder', async () => {
    const longest = SEARCH_BACKOFF_MS.at(-1) as number;
    const search = searchFor('/work/app');
    for (const step of SEARCH_BACKOFF_MS) {
      await search();
      clock += step;
    }
    await search();
    const path = writeTranscriptIn('-elsewhere-app');

    clock += longest - 1;
    expect(await search()).toBeUndefined();
    clock += 1;
    expect(await search()).toBe(path);
  });

  it('finds the transcript of a work folder with a name too long to make only by its search of every folder', async () => {
    const directory = `/${'a'.repeat(240)}`;
    const search = searchFor(directory);
    const path = writeTranscriptIn(`-${'a'.repeat(199)}-hash`);

    expect(await search()).toBe(path);
  });
});
