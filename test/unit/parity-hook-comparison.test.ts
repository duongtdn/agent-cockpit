import { describe, expect, it } from 'vitest';
import {
  comparable,
  type ObservedHook,
  type OwnValues,
} from '../support/parity/hook-comparison.ts';

const real: OwnValues = { sessionIds: ['real-session'], workFolder: '/tmp/real/work' };
const fake: OwnValues = { sessionIds: ['fake-session'], workFolder: '/tmp/fake/work' };

function hook(
  event: string,
  payload: Record<string, unknown> = {},
  via: ObservedHook['via'] = 'http',
): ObservedHook {
  return { event, via, payload };
}

describe('two agents agree', () => {
  it('on a session id and a work folder that are each their own, wherever they stand', () => {
    const suggestions = (folder: string) => [{ type: 'addDirectories', directories: [folder] }];
    const ofReal = hook('PermissionRequest', {
      session_id: real.sessionIds[0],
      cwd: real.workFolder,
      permission_suggestions: suggestions(real.workFolder),
    });
    const ofFake = hook('PermissionRequest', {
      session_id: fake.sessionIds[0],
      cwd: fake.workFolder,
      permission_suggestions: suggestions(fake.workFolder),
    });

    expect(comparable([ofFake], fake)).toEqual(comparable([ofReal], real));
  });

  it('on ids and paths that differ, when each comes back where the other does', () => {
    const turn = (path: string, prompt: string, call: string) => [
      hook('PreToolUse', { transcript_path: path, prompt_id: prompt, tool_use_id: call }),
      hook('PostToolBatch', { prompt_id: prompt, tool_calls: [{ tool_use_id: call }] }),
    ];

    expect(comparable(turn('/fake.jsonl', 'p-9', 'toolu_fake_1'), fake)).toEqual(
      comparable(turn('/real.jsonl', 'c3d1', 'toolu_01'), real),
    );
  });

  it('on the ids of every session launched, by the order of their launches', () => {
    const own = { sessionIds: ['first', 'second'], workFolder: '/work' };
    const other = { sessionIds: ['one', 'two'], workFolder: '/work' };

    expect(comparable([hook('SessionStart', { session_id: 'second' })], own)).toEqual(
      comparable([hook('SessionStart', { session_id: 'two' })], other),
    );
    expect(comparable([hook('SessionStart', { session_id: 'first' })], own)).not.toEqual(
      comparable([hook('SessionStart', { session_id: 'two' })], other),
    );
  });

  it('on an id an agent drew, wherever a text holds it, whatever the order of the keys', () => {
    const launched = (agent: string, file: string, call: string, reversed: boolean) => {
      const response = { agentId: agent, outputFile: file };
      return [
        hook('SubagentStart', { agent_id: agent }),
        hook(
          'PostToolUse',
          reversed
            ? { tool_response: response, tool_use_id: call }
            : { tool_use_id: call, tool_response: response },
        ),
        hook('UserPromptSubmit', {
          prompt: `<task-id>${agent}</task-id>\n<tool-use-id>${call}</tool-use-id>\n<output-file>${file}</output-file>`,
        }),
      ];
    };

    expect(
      comparable(launched('a1fake', '/tmp/f/a1fake.output', 'toolu_fake_1', true), fake),
    ).toEqual(comparable(launched('a9real', '/tmp/r/a9real.output', 'toolu_01', false), real));
  });

  it('on a field of one type written as a tag inside a text', () => {
    const notification = (ms: number, tokens: number) =>
      hook('UserPromptSubmit', {
        prompt: `<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>1</tool_uses><duration_ms>${ms}</duration_ms></usage>`,
      });

    expect(comparable([notification(3, 0)], fake)).toEqual(
      comparable([notification(1388, 15)], real),
    );
    expect(comparable([notification(3, 0)], fake)).not.toEqual(
      comparable(
        [{ ...notification(3, 0), payload: { prompt: '<tool_uses>2</tool_uses>' } }],
        real,
      ),
    );
  });

  it('on a duration, a model and the costs of a resumed conversation of one type', () => {
    const start = (seconds: number, model: string) =>
      hook('SessionStart', { model, seconds_since_last_response: seconds, duration_ms: seconds });

    expect(comparable([start(0, 'haiku')], fake)).toEqual(
      comparable([start(3, 'claude-haiku-5-5')], real),
    );
  });

  it.each([
    [
      'a MessageDisplay and the Stop after it',
      [hook('MessageDisplay'), hook('Stop')],
      [hook('Stop'), hook('MessageDisplay')],
    ],
    [
      'the post and the command of one event',
      [hook('SessionEnd'), hook('SessionEnd', {}, 'command')],
      [hook('SessionEnd', {}, 'command'), hook('SessionEnd')],
    ],
  ])('on %s, whichever arrived first', (_pair, oneWay, otherWay) => {
    expect(comparable(otherWay, fake)).toEqual(comparable(oneWay, real));
  });
});

describe('two agents differ', () => {
  function expectDifferent(ofFake: ObservedHook[], ofReal: ObservedHook[]): void {
    expect(comparable(ofFake, fake)).not.toEqual(comparable(ofReal, real));
  }

  it('on a key one payload has and the other has not, nested ones too', () => {
    expectDifferent([hook('Stop', { permission_mode: 'default' })], [hook('Stop')]);
    expectDifferent(
      [hook('Stop', { effort: { level: 'medium', more: 1 } })],
      [hook('Stop', { effort: { level: 'medium' } })],
    );
  });

  it('on the kind of hook that carried an event', () => {
    expectDifferent([hook('SessionStart')], [hook('SessionStart', {}, 'command')]);
  });

  it('on a value the scenario determines', () => {
    expectDifferent(
      [hook('Stop', { last_assistant_message: 'Done' })],
      [hook('Stop', { last_assistant_message: 'Done.' })],
    );
  });

  it("on a session id or a folder that is not the agent's own", () => {
    expectDifferent(
      [hook('Stop', { session_id: 'another-session' })],
      [hook('Stop', { session_id: real.sessionIds[0] })],
    );
    expectDifferent(
      [hook('Stop', { cwd: '/elsewhere' })],
      [hook('Stop', { cwd: real.workFolder })],
    );
  });

  it('on an id that changes where the other agent repeats it', () => {
    const turn = (first: string, second: string) => [
      hook('UserPromptSubmit', { prompt_id: first }),
      hook('Stop', { prompt_id: second }),
    ];

    expectDifferent(turn('a', 'b'), turn('c', 'c'));
  });

  it('on the type of a value that differs by nature', () => {
    expectDifferent(
      [hook('PostToolUse', { duration_ms: '3' })],
      [hook('PostToolUse', { duration_ms: 3 })],
    );
    expectDifferent([hook('Stop', { prompt_id: 3 })], [hook('Stop', { prompt_id: 'c3d1' })]);
  });

  it('on the order of any other two hooks', () => {
    expectDifferent(
      [hook('PostToolUse'), hook('PreToolUse')],
      [hook('PreToolUse'), hook('PostToolUse')],
    );
    expectDifferent(
      [hook('MessageDisplay'), hook('PostToolBatch')],
      [hook('PostToolBatch'), hook('MessageDisplay')],
    );
  });

  it('on a hook one of them never sent', () => {
    expectDifferent([hook('PreToolUse')], [hook('PreToolUse'), hook('PostToolBatch')]);
  });
});
