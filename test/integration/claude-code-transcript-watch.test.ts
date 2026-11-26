import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  followTranscript,
  TRANSCRIPT_POLL_MS,
  type TranscriptWatch,
} from '../../src/claude-code/transcript-watch.ts';
import type { DriverEvent } from '../../src/server/driver.ts';
import { eventually } from '../support/eventually.ts';

const CONVERSATION = '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11';
const PROMPT = { type: 'user', message: { role: 'user', content: 'Explain a.ts' } };
const MARKER = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
};

let configFolder: string;
let transcript: string;
let reported: DriverEvent[];
let watch: TranscriptWatch | undefined;

beforeEach(() => {
  configFolder = mkdtempSync(join(tmpdir(), 'cockpit-transcript-'));
  transcript = join(configFolder, 'projects', '-work-chapter-1', `${CONVERSATION}.jsonl`);
  reported = [];
});

afterEach(() => {
  watch?.stop();
  watch = undefined;
  rmSync(configFolder, { recursive: true, force: true });
});

async function follow(): Promise<void> {
  watch = followTranscript({ configFolder, conversationId: CONVERSATION }, (events) =>
    reported.push(...events),
  );
  await watch.begun;
}

function write(...entries: unknown[]): void {
  mkdirSync(join(configFolder, 'projects', '-work-chapter-1'), { recursive: true });
  appendFileSync(transcript, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

/** Waits until the watch has read the transcript as it is now: a marker written after it is reported. */
async function readUpToNow(): Promise<void> {
  write(MARKER);
  await eventually(() => expect(reported).toHaveLength(1));
  reported.length = 0;
}

describe("the Claude Code driver's watch of a transcript", () => {
  it('reports an interruption marker written into a transcript that appears after the watch began', async () => {
    await follow();

    write(PROMPT, MARKER);

    await eventually(() => expect(reported).toEqual([{ type: 'interrupted' }]));
  });

  it('reports each marker written while it watches, and nothing for the other entries', async () => {
    write(PROMPT);
    await follow();
    await readUpToNow();

    write({ type: 'assistant', message: { role: 'assistant', content: [] } }, MARKER, PROMPT);
    write(MARKER);

    await eventually(() =>
      expect(reported).toEqual([{ type: 'interrupted' }, { type: 'interrupted' }]),
    );
  });

  it('never reports what the transcript held before the watch began: a resumed conversation', async () => {
    write(PROMPT, MARKER);
    await follow();

    await readUpToNow();
    expect(reported).toEqual([]);
  });

  it('reports nothing once stopped', async () => {
    await follow();
    write(PROMPT);
    await readUpToNow();

    watch?.stop();
    write(MARKER);
    // Nothing announces a read that does not happen: a few of the watch's rounds go by.
    await new Promise((resolve) => setTimeout(resolve, 3 * TRANSCRIPT_POLL_MS));

    expect(reported).toEqual([]);
  });
});
