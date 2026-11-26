import { describe, expect, it, vi } from 'vitest';
import { CANNOT_PLAY_STATUS } from '../support/fake-agent/agent.ts';
import { type Played, playFakeAgent as start, submit } from '../support/played-fake-agent.ts';

const touch = { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } } as const;
const write = { do: 'tool', name: 'Write', input: { file_path: 'a.txt', content: '' } } as const;
const reply = { do: 'reply', text: 'Done.' } as const;

/** Waits until the agent has failed, and checks it said why and went no further. */
async function expectFailure(played: Played, problem: RegExp): Promise<void> {
  await vi.waitFor(() => expect(played.exits).toEqual([CANNOT_PLAY_STATUS]));
  expect(played.screen().problem).toMatch(problem);
  const firedThen = [...played.fired];
  submit(played, 'anyone there?');
  played.agent.press({ kind: 'escape' });
  await played.agent.terminate();
  expect(played.fired).toEqual(firedThen);
  expect(played.exits).toEqual([CANNOT_PLAY_STATUS]);
}

describe('the fake agent, asked to play what it has no evidence for', () => {
  it('exits with a status that is no success and no signal', () => {
    expect(CANNOT_PLAY_STATUS).toBeGreaterThan(0);
    expect(CANNOT_PLAY_STATUS).toBeLessThan(126);
  });

  it('fails on a prompt its script has no turn for, and answers nothing', async () => {
    const played = await start({ script: [[reply]] });
    submit(played, 'scripted');
    await vi.waitFor(() => expect(played.fired).toContain('Stop'));

    submit(played, 'not scripted');

    await expectFailure(played, /no turn for prompt 2.*1 turn/);
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'MessageDisplay', 'Stop']);
  });

  it('fails on a script it cannot read', async () => {
    const played = await start({
      script: () => {
        throw new Error('turn 1 has no step');
      },
    });

    submit(played, 'hello');

    await expectFailure(played, /turn 1 has no step/);
  });

  it('fails on an Enter while a turn runs, whatever the input box holds', async () => {
    for (const typed of ['and this too', '']) {
      const played = await start({ script: [[{ do: 'stay-busy' }]] });
      submit(played, 'work');
      await vi.waitFor(() => expect(played.fired).toContain('UserPromptSubmit'));

      played.agent.press({ kind: 'text', text: typed });
      played.agent.press({ kind: 'enter' });

      await expectFailure(played, /Enter.*while a turn runs/);
      expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit']);
    }
  });

  it('still loses the Enter of an idle session with an empty input box', async () => {
    const played = await start({ script: [[reply]] });

    played.agent.press({ kind: 'enter' });
    submit(played, 'hello');

    await vi.waitFor(() => expect(played.fired).toContain('Stop'));
    expect(played.exits).toEqual([]);
  });

  it.each(['deny', 'ask', 'defer'])(
    'fails when a PreToolUse hook answers "%s"',
    async (decision) => {
      const played = await start({
        script: [[touch, reply]],
        hookAnswers: {
          PreToolUse: {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision },
          },
        },
      });

      submit(played, 'touch it');

      await expectFailure(played, new RegExp(`PreToolUse.*"${decision}"`));
      expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
    },
  );

  const permissionAnswer = (decision: object) => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });

  it.each([
    [
      'SessionStart',
      { hookSpecificOutput: { additionalContext: 'Remember.' } },
      /SessionStart.*"hookSpecificOutput"/,
      ['SessionStart'],
    ],
    [
      'UserPromptSubmit',
      { decision: 'block', reason: 'Not now.' },
      /UserPromptSubmit.*"decision"/,
      ['SessionStart', 'UserPromptSubmit'],
    ],
    [
      'Stop',
      { decision: 'block', reason: 'Go on.' },
      /Stop.*"decision"/,
      [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest',
        'PostToolUse',
        'MessageDisplay',
        'Stop',
      ],
    ],
    [
      'PostToolUse',
      { continue: false },
      /PostToolUse.*"continue"/,
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse'],
    ],
    [
      'PermissionRequest',
      permissionAnswer({ behavior: 'allow', updatedPermissions: [{ type: 'addRules' }] }),
      /PermissionRequest.*"updatedPermissions"/,
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest'],
    ],
    [
      'PermissionRequest',
      permissionAnswer({ behavior: 'ask' }),
      /PermissionRequest.*"ask"/,
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest'],
    ],
  ])(
    'fails when a %s hook answers what it does not play: %j',
    async (event, answer, problem, firedBefore) => {
      const allowed = permissionAnswer({ behavior: 'allow' });
      const played = await start({
        script: [[touch, reply]],
        hookAnswers: { PermissionRequest: allowed, [event]: answer },
      });

      submit(played, 'touch it');

      await expectFailure(played, problem);
      expect(played.fired).toEqual(firedBefore);
    },
  );

  it('fails on a reply of several lines when MessageDisplay has a hook: how Claude Code parts one is not known', async () => {
    const played = await start({ script: [[{ do: 'reply', text: 'One.\n\nTwo.' }]] });

    submit(played, 'do it');

    await expectFailure(played, /MessageDisplay.*a reply of several lines/);
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(played.recorded).toEqual(['do it']);
  });

  it('fails when a MessageDisplay hook answers what it does not play, after the turn too', async () => {
    const played = await start({
      script: [[reply]],
      hookAnswers: { MessageDisplay: { continue: false } },
    });

    submit(played, 'do it');

    await expectFailure(played, /MessageDisplay.*"continue"/);
  });

  it('fails when a hook fails, with what its runner says of it', async () => {
    const failed = Promise.reject(new Error('a Stop command hook exited with status 3'));
    const played = await start({ script: [[reply]], hookAnswers: { Stop: failed } });

    submit(played, 'do it');

    await expectFailure(played, /a Stop command hook exited with status 3/);
  });

  it('fails when a SessionEnd hook answers what it does not play, in place of its own exit', async () => {
    const played = await start({
      script: [[reply]],
      hookAnswers: { SessionEnd: { continue: false } },
    });

    await played.agent.terminate();

    expect(played.exits).toEqual([CANNOT_PLAY_STATUS]);
    expect(played.screen().problem).toMatch(/SessionEnd.*"continue"/);
  });

  it.each(['acceptEdits', 'plan', 'auto', 'bypassPermissions'])(
    'fails on a tool that is no touch in the %s mode, and runs a touch',
    async (mode) => {
      const played = await start({
        script: [
          [touch, reply],
          [write, reply],
        ],
        mode,
      });
      submit(played, 'touch it');
      await vi.waitFor(() => expect(played.fired).toContain('Stop'));
      expect(played.fired).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'MessageDisplay',
        'Stop',
      ]);

      submit(played, 'write it');

      await expectFailure(played, new RegExp(`Write.*${mode}`));
      expect(played.fired.slice(6)).toEqual(['UserPromptSubmit', 'PreToolUse']);
    },
  );

  it('fails on a call in a mode it does not know', async () => {
    const played = await start({ script: [[touch, reply]], mode: 'yolo' });

    submit(played, 'touch it');

    await expectFailure(played, /Bash.*yolo/);
  });
});
