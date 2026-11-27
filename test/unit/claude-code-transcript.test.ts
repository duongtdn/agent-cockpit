import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eventsIn, isInterruption } from '../../src/claude-code/transcript-watch.ts';

/** An entry as Claude Code writes one of its own into a conversation: a `user` message of text blocks. */
function userBlocks(text: string): object {
  return {
    type: 'user',
    sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
    timestamp: '2026-11-26T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

describe("the transcript's interruption markers", () => {
  it.each([
    ['while the agent writes', '[Request interrupted by user]'],
    ['while a tool call is open', '[Request interrupted by user for tool use]'],
  ])('tells the marker of a turn interrupted %s', (_, marker) => {
    expect(isInterruption(userBlocks(marker))).toBe(true);
  });

  it.each([
    [
      'a prompt that reads as a marker: typed, its content a text',
      {
        type: 'user',
        message: { role: 'user', content: '[Request interrupted by user]' },
      },
    ],
    [
      'an answer of the agent',
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      },
    ],
    ['another text of the agent’s own', userBlocks('[This turn ended before it finished.]')],
    [
      'a tool result',
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }],
        },
      },
    ],
    ['an entry with no message', { type: 'system', subtype: 'turn_duration' }],
    ['what is no entry', 'user'],
    ['nothing', null],
  ])('tells no interruption in %s', (_, entry) => {
    expect(isInterruption(entry)).toBe(false);
  });
});

describe('the events in what a transcript was written with', () => {
  const marker = JSON.stringify(userBlocks('[Request interrupted by user]'));
  const prompt = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Go é' } });

  const interrupted = { type: 'interrupted', at: '2026-11-26T10:00:00.000Z' };

  it('reads whole lines, and keeps a line not yet whole for later', () => {
    const { events, rest } = eventsIn(Buffer.from(`${prompt}\n${marker}\n${marker.slice(0, 20)}`));

    expect(events).toEqual([interrupted]);
    expect(rest.toString()).toBe(marker.slice(0, 20));
    expect(eventsIn(Buffer.concat([rest, Buffer.from(`${marker.slice(20)}\n`)])).events).toEqual([
      interrupted,
    ]);
  });

  it('tells when the agent recorded an interruption, as its entry says', () => {
    const untimed = JSON.stringify({ ...JSON.parse(marker), timestamp: undefined });
    const unreadable = JSON.stringify({ ...JSON.parse(marker), timestamp: 'soon' });

    expect(eventsIn(Buffer.from(`${marker}\n${untimed}\n${unreadable}\n`)).events).toEqual([
      interrupted,
      { type: 'interrupted' },
      { type: 'interrupted' },
    ]);
  });

  it('keeps a character cut between two writes whole', () => {
    const bytes = Buffer.from(`${prompt}\n`);
    const cut = bytes.indexOf(Buffer.from('é')) + 1;

    const first = eventsIn(bytes.subarray(0, cut));
    const second = eventsIn(Buffer.concat([first.rest, bytes.subarray(cut)]));

    expect(first.rest).toEqual(bytes.subarray(0, cut));
    expect(second).toEqual({ events: [], rest: Buffer.alloc(0) });
  });

  it('skips a line that is no JSON, and blank lines', () => {
    expect(eventsIn(Buffer.from(`not json\n\n${marker}\n`)).events).toEqual([interrupted]);
  });
});

/**
 * Transcripts of Claude Code 2.1.332 against the scripted API, the agent's
 * bookkeeping of its requests left out: local commands given as the launch
 * prompt (`launch-`: `/clear`'s is its new conversation), and a `/compact`
 * typed after a turn that completes, fails on an API error, or is
 * interrupted by an Esc (`compact-`).
 */
const TRANSCRIPTS = fileURLToPath(new URL('../fixtures/transcripts/', import.meta.url));

function transcript(name: string): Buffer {
  return readFileSync(`${TRANSCRIPTS}${name}.jsonl`);
}

describe('the end of a command of the agent’s own, in a transcript', () => {
  const done = { type: 'command-done' };

  it.each([
    // The command's output; `/context` writes no caveat.
    ['launch-context', [done]],
    // The caveat, then the output.
    ['launch-clear', [done, done]],
    ['launch-compact', [done, done]],
    // The unknown command's own entry.
    ['launch-nosuchcommand', [done]],
    ['compact-completes', [done, done]],
    ['compact-fails', [done, done]],
    // The caveat alone: no command name, no output.
    ['compact-interrupted', [done]],
  ])('is read in %s', (name, events) => {
    expect(eventsIn(transcript(name)).events).toEqual(events);
  });

  it.each([
    [
      'a prompt the person typed that reads as a command’s output',
      {
        type: 'user',
        promptSource: 'typed',
        message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' },
      },
    ],
    [
      'the command’s name alone',
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/context</command-name>',
      },
    ],
    [
      'an informational entry of another kind',
      { type: 'system', subtype: 'informational', content: 'Resuming the conversation.' },
    ],
    [
      'an entry of the agent’s that quotes the tag inside',
      { type: 'system', subtype: 'local_command', content: 'see <local-command-stdout>' },
    ],
    [
      'an answer of the agent’s',
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '<local-command-caveat>' }] },
      },
    ],
  ])('is not read in %s', (_, entry) => {
    expect(eventsIn(Buffer.from(`${JSON.stringify(entry)}\n`)).events).toEqual([]);
  });
});
