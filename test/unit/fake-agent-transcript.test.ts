import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countPrompts,
  findTranscript,
  INTERRUPTED,
  INTERRUPTED_FOR_TOOL_USE,
  openTranscript,
  transcriptPathFor,
} from '../support/fake-agent/transcript.ts';

const ID = '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11';
let configFolder: string;

beforeEach(() => {
  configFolder = mkdtempSync(join(tmpdir(), 'cockpit-fake-agent-transcript-'));
});

afterEach(() => {
  rmSync(configFolder, { recursive: true, force: true });
});

function entriesOf(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the fake agent's transcript", () => {
  it("is a file of the configuration folder, under the project of the session's folder", () => {
    expect(transcriptPathFor('/config', '/work/unit_1/a.b', ID)).toBe(
      `/config/projects/-work-unit-1-a-b/${ID}.jsonl`,
    );
  });

  it('records a prompt, a reply and an interruption, one entry a line', () => {
    const path = transcriptPathFor(configFolder, '/work/unit', ID);
    const transcript = openTranscript(path, ID);

    transcript.recordPrompt('hello');
    transcript.recordReply('Hi.');
    transcript.recordInterruption(INTERRUPTED);

    expect(entriesOf(path)).toMatchObject([
      { type: 'user', sessionId: ID, message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        sessionId: ID,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      },
    ]);
    expect(entriesOf(path).every((entry) => typeof entry.timestamp === 'string')).toBe(true);
  });

  it('names the two interruption markers (behavior 6)', () => {
    expect(INTERRUPTED).toBe('[Request interrupted by user]');
    expect(INTERRUPTED_FOR_TOOL_USE).toBe('[Request interrupted by user for tool use]');
  });

  it('is found again by its session, from any folder (behavior 3)', () => {
    const path = transcriptPathFor(configFolder, '/work/unit', ID);
    openTranscript(path, ID).recordPrompt('hello');

    expect(findTranscript(configFolder, ID)).toBe(path);
  });

  it('is not found for a session that recorded nothing', () => {
    openTranscript(transcriptPathFor(configFolder, '/work/unit', ID), ID);

    expect(findTranscript(configFolder, ID)).toBeUndefined();
    expect(findTranscript(join(configFolder, 'absent'), ID)).toBeUndefined();
  });

  it('counts the prompts of the conversation, not its interruptions', () => {
    const path = transcriptPathFor(configFolder, '/work/unit', ID);
    const transcript = openTranscript(path, ID);
    transcript.recordPrompt('one');
    transcript.recordInterruption(INTERRUPTED_FOR_TOOL_USE);
    transcript.recordPrompt('two');
    transcript.recordReply('Done.');

    expect(countPrompts(path)).toBe(2);
    expect(countPrompts(join(configFolder, 'absent.jsonl'))).toBe(0);
  });
});
