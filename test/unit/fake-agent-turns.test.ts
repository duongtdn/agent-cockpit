import { describe, expect, it, vi } from 'vitest';
import { INTERRUPTED, INTERRUPTED_FOR_TOOL_USE } from '../support/fake-agent/transcript.ts';
import { type Played, playFakeAgent, submit } from '../support/played-fake-agent.ts';

const touch = { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } } as const;
const stayBusy = { do: 'stay-busy' } as const;
const reply = { do: 'reply', text: 'Done.' } as const;
const allowed = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
};

function fires(played: Played, event: string): Promise<void> {
  return vi.waitFor(() => expect(played.fired).toContain(event));
}

function becomesIdle(played: Played): Promise<void> {
  return vi.waitFor(() => expect(played.screen().state).toBe('idle'));
}

describe('the fake agent, interrupted with Esc', () => {
  it('withdraws a prompt nothing was produced for: back in the input box, no hook, no marker (behavior 23)', async () => {
    const played = await playFakeAgent({ script: [[stayBusy]] });
    submit(played, 'think about it');
    await fires(played, 'UserPromptSubmit');
    expect(played.screen()).toMatchObject({
      state: 'busy',
      lastPrompt: 'think about it',
      input: '',
    });

    played.agent.press({ kind: 'escape' });

    await becomesIdle(played);
    expect(played.screen()).toMatchObject({ lastPrompt: undefined, input: 'think about it' });
    expect(played.recorded).toEqual(['think about it']);
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(played.exits).toEqual([]);
  });

  it('shows again the prompt taken before a withdrawn one', async () => {
    const played = await playFakeAgent({ script: [[reply], [stayBusy]] });
    submit(played, 'first');
    await fires(played, 'Stop');
    submit(played, 'second');
    await vi.waitFor(() => expect(played.screen().lastPrompt).toBe('second'));

    played.agent.press({ kind: 'escape' });

    await becomesIdle(played);
    expect(played.screen()).toMatchObject({ lastPrompt: 'first', input: 'second' });
  });

  it('takes the withdrawn prompt again on Enter, as the next prompt of the script', async () => {
    const played = await playFakeAgent({ script: [[stayBusy], [reply]] });
    submit(played, 'think about it');
    await fires(played, 'UserPromptSubmit');
    played.agent.press({ kind: 'escape' });
    await becomesIdle(played);

    played.agent.press({ kind: 'enter' });

    await fires(played, 'Stop');
    expect(played.events.map((event) => event.fields.prompt ?? event.name)).toEqual([
      'SessionStart',
      'think about it',
      'think about it',
      'Stop',
    ]);
  });

  it('records the marker once the turn produced something, and leaves the input box empty (behaviors 6, 22)', async () => {
    const played = await playFakeAgent({
      script: [[touch, stayBusy]],
      hookAnswers: { PreToolUse: allowed },
    });
    submit(played, 'touch, then think');
    await fires(played, 'PostToolUse');

    played.agent.press({ kind: 'escape' });

    await becomesIdle(played);
    expect(played.recorded).toEqual(['touch, then think', INTERRUPTED]);
    expect(played.screen()).toMatchObject({ lastPrompt: 'touch, then think', input: '' });
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
  });

  it('records the marker of a tool use while a call is open (behavior 6)', async () => {
    const played = await playFakeAgent({ script: [[touch, reply]] });
    submit(played, 'touch it');
    await vi.waitFor(() => expect(played.screen().dialog).toBeDefined());

    played.agent.press({ kind: 'escape' });

    await becomesIdle(played);
    expect(played.recorded).toEqual(['touch it', INTERRUPTED_FOR_TOOL_USE]);
  });

  it('records the marker, and withdraws nothing, when the input box holds text typed meanwhile', async () => {
    const played = await playFakeAgent({ script: [[stayBusy]] });
    submit(played, 'think about it');
    await fires(played, 'UserPromptSubmit');
    played.agent.press({ kind: 'text', text: 'typed meanwhile' });

    played.agent.press({ kind: 'escape' });

    await becomesIdle(played);
    expect(played.recorded).toEqual(['think about it', INTERRUPTED]);
    expect(played.screen()).toMatchObject({
      lastPrompt: 'think about it',
      input: 'typed meanwhile',
    });
  });
});

describe('the fake agent, ending', () => {
  it('on a scripted exit, tells SessionEnd the person left and exits with success', async () => {
    const played = await playFakeAgent({ script: [[{ do: 'exit' }]] });

    submit(played, 'leave');

    await vi.waitFor(() => expect(played.exits).toEqual([0]));
    expect(played.events.at(-1)).toMatchObject({
      name: 'SessionEnd',
      fields: { reason: 'prompt_input_exit' },
    });
  });

  it('terminated, tells SessionEnd of another reason and exits with the status of the signal', async () => {
    const played = await playFakeAgent({ script: [[stayBusy]] });
    submit(played, 'work');
    await fires(played, 'UserPromptSubmit');

    await played.agent.terminate();

    expect(played.exits).toEqual([143]);
    expect(played.events.at(-1)).toMatchObject({ name: 'SessionEnd', fields: { reason: 'other' } });
    expect(played.recorded).toEqual(['work']);
  });
});
