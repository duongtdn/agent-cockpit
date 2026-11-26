import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { followTranscript, type TranscriptWatch } from '../../src/claude-code/transcript-watch.ts';
import type { DriverEvent } from '../../src/server/driver.ts';
import { eventually } from '../support/eventually.ts';

const CONVERSATION = '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11';
/** The work folder, whose project folder holds the conversation. */
const DIRECTORY = '/work/chapter-1';
const PROMPT = { type: 'user', message: { role: 'user', content: 'Explain a.ts' } };
const RECORDED_AT = '2026-11-27T10:00:00.000Z';
const MARKER = {
  type: 'user',
  timestamp: RECORDED_AT,
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
};
const INTERRUPTED = { type: 'interrupted', at: RECORDED_AT };

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

function followInto(into: DriverEvent[]): TranscriptWatch {
  return followTranscript(
    { configFolder, conversationId: CONVERSATION, directory: DIRECTORY },
    (events) => into.push(...events),
  );
}

async function follow(): Promise<void> {
  watch = followInto(reported);
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

    await eventually(() => expect(reported).toEqual([INTERRUPTED]));
  });

  it('reports each marker written while it watches, and nothing for the other entries', async () => {
    write(PROMPT);
    await follow();
    await readUpToNow();

    write({ type: 'assistant', message: { role: 'assistant', content: [] } }, MARKER, PROMPT);
    write(MARKER);

    await eventually(() => expect(reported).toEqual([INTERRUPTED, INTERRUPTED]));
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
    // A watch that goes on: once it read the marker, the stopped one has had its rounds too.
    const control: DriverEvent[] = [];
    const going = followInto(control);
    await going.begun;

    watch?.stop();
    write(MARKER);
    await eventually(() => expect(control).toEqual([INTERRUPTED]));
    going.stop();

    expect(reported).toEqual([]);
  });

  it('reads a transcript that shrank again from its start: the agent wrote it anew', async () => {
    write(PROMPT, PROMPT, PROMPT);
    await follow();
    await readUpToNow();

    writeFileSync(transcript, `${JSON.stringify(MARKER)}\n`);

    await eventually(() => expect(reported).toEqual([INTERRUPTED]));
  });
});
