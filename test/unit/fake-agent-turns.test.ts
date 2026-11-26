import { describe, expect, it, vi } from 'vitest';
import { INTERRUPTED, INTERRUPTED_FOR_TOOL_USE } from '../support/fake-agent/transcript.ts';
import { type Played, playFakeAgent, submit, WORK_FOLDER } from '../support/played-fake-agent.ts';

const touch = {
  do: 'tool',
  name: 'Bash',
  input: { command: 'touch a.txt' },
  result: '(Bash completed with no output)',
} as const;
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
      'MessageDisplay',
      'Stop',
    ]);
  });

  it('records the marker once the turn produced something, and leaves the input box empty (behaviors 6, 22)', async () => {
    const played = await playFakeAgent({
      script: [[touch, stayBusy]],
      hookAnswers: { PreToolUse: allowed },
    });
    submit(played, 'touch, then think');
    await vi.waitFor(() => expect(played.screen().step).toBe('stay-busy'));

    played.agent.press({ kind: 'escape' });

    await becomesIdle(played);
    expect(played.recorded).toEqual(['touch, then think', INTERRUPTED]);
    expect(played.screen()).toMatchObject({
      lastPrompt: 'touch, then think',
      input: '',
      step: undefined,
    });
    expect(played.fired).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolBatch',
    ]);
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

describe('the fake agent, showing a reply', () => {
  const messageDisplays = (played: Played) =>
    played.events.filter((event) => event.name === 'MessageDisplay').map((event) => event.fields);

  it('tells MessageDisplay of the reply, then Stop', async () => {
    const played = await playFakeAgent({ script: [[reply]] });

    submit(played, 'do it');

    await fires(played, 'Stop');
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'MessageDisplay', 'Stop']);
    expect(messageDisplays(played)).toEqual([
      {
        prompt_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        turn_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        message_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        index: 0,
        final: true,
        delta: 'Done.',
      },
    ]);
  });

  it('gives each turn a turn of its own and each reply a message of its own', async () => {
    const played = await playFakeAgent({ script: [[reply], [reply]] });
    submit(played, 'first');
    await fires(played, 'Stop');

    submit(played, 'second');

    await vi.waitFor(() => expect(messageDisplays(played)).toHaveLength(2));
    const [first, second] = messageDisplays(played);
    expect(second?.turn_id).not.toBe(first?.turn_id);
    expect(second?.message_id).not.toBe(first?.message_id);
  });

  it('ends the turn with Stop while a MessageDisplay hook has not answered', async () => {
    const played = await playFakeAgent({
      script: [[reply]],
      hookAnswers: { MessageDisplay: new Promise(() => {}) },
    });

    submit(played, 'do it');

    await becomesIdle(played);
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'MessageDisplay', 'Stop']);
  });

  it('tells no MessageDisplay when the settings give it no hook, whatever the reply', async () => {
    const played = await playFakeAgent({
      script: [[{ do: 'reply', text: 'One.\n\nTwo.' }]],
      withoutHooksFor: ['MessageDisplay'],
    });

    submit(played, 'do it');

    await becomesIdle(played);
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(played.exits).toEqual([]);
  });
});

describe('the fake agent, calling a tool', () => {
  const permissionAnswer = (decision: object) => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });
  const batches = (played: Played) =>
    played.events
      .filter((event) => event.name === 'PostToolBatch')
      .flatMap((event) => event.fields.tool_calls as { tool_response: string }[])
      .map((call) => call.tool_response);

  it('tells PostToolBatch, after PostToolUse, what the model is told of a call that ran', async () => {
    const played = await playFakeAgent({
      script: [[touch, reply]],
      hookAnswers: { PermissionRequest: permissionAnswer({ behavior: 'allow' }) },
    });

    submit(played, 'touch it');

    await fires(played, 'Stop');
    expect(played.fired).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'PostToolBatch',
      'MessageDisplay',
      'Stop',
    ]);
    expect(batches(played)).toEqual(['(Bash completed with no output)']);
  });

  it.each([
    ['its message', { message: 'Not this file.' }, 'Not this file.'],
    ['that a hook denied it, when the hook gives no message', {}, 'Permission denied by hook'],
  ])(
    'tells PostToolBatch of a call a hook denied, with %s, and no PostToolUse',
    async (_what, more, told) => {
      const played = await playFakeAgent({
        script: [[touch, reply]],
        hookAnswers: { PermissionRequest: permissionAnswer({ behavior: 'deny', ...more }) },
      });

      submit(played, 'touch it');

      await fires(played, 'Stop');
      expect(played.fired).not.toContain('PostToolUse');
      expect(batches(played)).toEqual([told]);
    },
  );

  it('tells PostToolBatch of a call the dontAsk mode denied, in the words of Claude Code', async () => {
    const played = await playFakeAgent({ script: [[touch, reply]], mode: 'dontAsk' });

    submit(played, 'touch it');

    await fires(played, 'Stop');
    expect(played.fired).not.toContain('PostToolUse');
    expect(batches(played)).toEqual([
      expect.stringMatching(/^Permission to use Bash has been denied/),
    ]);
  });

  it('tells no PostToolBatch of a call whose denial interrupts the turn', async () => {
    const played = await playFakeAgent({
      script: [[touch, reply]],
      hookAnswers: { PermissionRequest: permissionAnswer({ behavior: 'deny', interrupt: true }) },
    });

    submit(played, 'touch it');

    await becomesIdle(played);
    expect(played.fired).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
    ]);
    expect(played.recorded).toEqual(['touch it', INTERRUPTED_FOR_TOOL_USE]);
  });

  it('runs with no ask a tool the settings allow', async () => {
    const played = await playFakeAgent({ script: [[touch, reply]], allowRules: ['Bash'] });

    submit(played, 'touch it');

    await fires(played, 'Stop');
    expect(played.fired).not.toContain('PermissionRequest');
    expect(played.fired).toContain('PostToolUse');
  });

  it('tells PermissionRequest what the ask of a touch suggests, for the folder of the session', async () => {
    const played = await playFakeAgent({ script: [[touch, reply]] });

    submit(played, 'touch it');

    await fires(played, 'PermissionRequest');
    expect(played.events.at(-1)?.fields.permission_suggestions).toEqual([
      { type: 'addDirectories', directories: [WORK_FOLDER], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
  });
});

describe('the fake agent, naming the prompt in its hooks', () => {
  const promptIds = (played: Played) => played.events.map((event) => event.fields.prompt_id);

  it('gives every hook of a turn the id of its prompt, and each prompt an id of its own', async () => {
    const played = await playFakeAgent({ script: [[reply], [reply]] });
    submit(played, 'first');
    await fires(played, 'Stop');

    submit(played, 'second');

    await vi.waitFor(() => expect(played.fired.filter((name) => name === 'Stop')).toHaveLength(2));
    const [start, ...ids] = promptIds(played);
    expect(start).toBeUndefined();
    expect(ids.slice(0, 3)).toEqual(Array(3).fill(ids[0]));
    expect(ids.slice(3)).toEqual(Array(3).fill(ids[3]));
    expect(ids[3]).not.toBe(ids[0]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives SessionEnd the id of the last prompt, and none when the process took no prompt', async () => {
    const prompted = await playFakeAgent({ script: [[reply]] });
    submit(prompted, 'first');
    await fires(prompted, 'Stop');
    const unprompted = await playFakeAgent({ script: [] });

    await prompted.agent.terminate();
    await unprompted.agent.terminate();

    expect(promptIds(prompted).at(-1)).toBe(promptIds(prompted).at(-2));
    expect(unprompted.events.at(-1)?.fields).toEqual({ reason: 'other' });
  });
});

describe('the fake agent, starting', () => {
  it('names the model of its launch in the SessionStart of a new session', async () => {
    const played = await playFakeAgent({ script: [] });

    expect(played.events[0]?.fields).toEqual({ source: 'startup', model: 'haiku' });
  });

  it('says in the SessionStart of a resumed session how long ago it last answered', async () => {
    const played = await playFakeAgent({ script: [], resumedAfterSeconds: 12 });

    expect(played.events[0]?.fields).toMatchObject({
      source: 'resume',
      seconds_since_last_response: 12,
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
