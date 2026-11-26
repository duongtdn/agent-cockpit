import { describe, expect, it, vi } from 'vitest';
import { CANNOT_PLAY_STATUS, promptOf } from '../support/fake-agent/agent.ts';
import { createKeyDecoder, type Key } from '../support/fake-agent/keys.ts';
import { type Played, playFakeAgent, submit } from '../support/played-fake-agent.ts';

const touch = {
  do: 'tool',
  name: 'Bash',
  input: { command: 'touch a.txt' },
  result: '(Bash completed with no output)',
} as const;
const reply = { do: 'reply', text: 'Done.' } as const;
const SEPARATOR = '⁣';
const text = (value: string): Key => ({ kind: 'text', text: value });

function press(played: Played, ...keys: Key[]): void {
  for (const key of keys) played.agent.press(key);
}

function exitsUnplayable(played: Played): Promise<void> {
  return vi.waitFor(() => expect(played.exits).toEqual([CANNOT_PLAY_STATUS]));
}

describe('the prompt the fake agent takes from its input box', () => {
  it.each([
    ['  two leading spaces', '  two leading spaces'],
    ['two trailing spaces  ', 'two trailing spaces'],
    ['a trailing line break\n', 'a trailing line break'],
    ['\na leading line break', '\na leading line break'],
    [`${SEPARATOR}the separator first`, 'the separator first'],
    [`the separator last  ${SEPARATOR}`, 'the separator last'],
  ])('is %j trimmed at its end and rid of the separator at its ends: %j', (typed, taken) => {
    expect(promptOf(typed)).toBe(taken);
  });

  it('refuses a separator inside a prompt: what Claude Code makes of it was not observed', () => {
    expect(() => promptOf(`one${SEPARATOR}two`)).toThrow(/not observed/);
  });

  it('is what Enter submits, a tab typed dropped', async () => {
    const played = await playFakeAgent({ script: [[reply]] });

    press(played, ...createKeyDecoder().decode(`a\ttab  ${SEPARATOR}\r`));

    await vi.waitFor(() => expect(played.recorded).toEqual(['atab', 'Done.']));
  });
});

describe('what the fake agent refuses of its input box', () => {
  it('Enter in shell mode: the text would run as a shell command', async () => {
    const played = await playFakeAgent({ script: [[reply]] });

    submit(played, '!ls');

    await exitsUnplayable(played);
    expect(played.fired).toEqual(['SessionStart']);
  });

  it('Enter on a box of blanks', async () => {
    const played = await playFakeAgent({ script: [[reply]] });

    submit(played, '   ');

    await exitsUnplayable(played);
  });

  it('a launch prompt that ends with a blank: whether Claude Code trims it there was not observed', async () => {
    const played = await playFakeAgent({ script: [[reply]], prompt: 'say it ' });

    await exitsUnplayable(played);
    expect(played.fired).toEqual(['SessionStart']);
  });

  it('Down past the box while a background task runs: Claude Code moves to the task', async () => {
    const task = {
      do: 'task',
      description: 'Count files',
      prompt: 'Count the files.',
      agentType: 'general-purpose',
      work: [reply],
    } as const;
    const played = await playFakeAgent({
      script: [[task, reply]],
      tasksReleased: new Promise(() => {}),
    });
    submit(played, 'start a task');
    await vi.waitFor(() => expect(played.fired).toContain('Stop'));

    press(played, text('one line'), { kind: 'down' });

    await exitsUnplayable(played);
  });

  it('Up into the history of a resumed conversation: Claude Code shows earlier sessions too', async () => {
    const played = await playFakeAgent({ script: [], resumedAfterSeconds: 5 });

    press(played, { kind: 'up' });

    await exitsUnplayable(played);
  });

  it('shows the history of its own prompts, and the rule that names the one shown', async () => {
    const played = await playFakeAgent({ script: [[reply], [reply]], prompt: 'first' });
    await vi.waitFor(() => expect(played.screen().state).toBe('idle'));
    submit(played, 'second');
    await vi.waitFor(() => expect(played.recorded).toHaveLength(4));

    press(played, { kind: 'up' }, { kind: 'up' });

    expect(played.screen().box).toMatchObject({ above: 'History 1/2', rows: ['❯ first'] });
  });
});

describe('the fake agent asking for permission', () => {
  /** A session whose tool call asks, its PermissionRequest hook unanswered. */
  async function asking(): Promise<Played> {
    const played = await playFakeAgent({
      script: [[touch, reply]],
      hookAnswers: { PermissionRequest: new Promise(() => {}) },
    });
    submit(played, 'touch it');
    await vi.waitFor(() => expect(played.fired).toContain('PermissionRequest'));
    return played;
  }

  it('draws its dialog a while after PermissionRequest: the keys typed meanwhile go to the input box', async () => {
    const played = await asking();

    press(played, text('typed early'));

    expect(played.screen()).toMatchObject({ dialog: undefined, state: 'busy' });
    await vi.waitFor(() => expect(played.screen().dialog).toBeDefined());
    expect(played.screen().box.rows).toEqual(['❯ typed early']);
  });

  it('ignores text typed on the dialog, and takes Enter as its Yes', async () => {
    const played = await asking();
    await vi.waitFor(() => expect(played.screen().dialog).toBeDefined());

    press(played, text('typed on the dialog'), { kind: 'enter' });

    await vi.waitFor(() => expect(played.recorded).toEqual(['touch it', 'Done.']));
    expect(played.screen().box.rows).toEqual(['❯ ']);
  });

  it.each<[string, Key]>([
    ['a digit alone, which may choose an option', text('2')],
    ['Down, which moves the selection', { kind: 'down' }],
    ['Ctrl+U', { kind: 'kill-line' }],
  ])('refuses %s on the dialog', async (_what, key) => {
    const played = await asking();
    await vi.waitFor(() => expect(played.screen().dialog).toBeDefined());

    press(played, key);

    await exitsUnplayable(played);
  });
});
