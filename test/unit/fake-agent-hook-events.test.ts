import { describe, expect, it } from 'vitest';
import { decisionOf } from '../support/fake-agent/hook-answers.ts';
import {
  afterPrompt,
  messageDisplay,
  payloadOf,
  permissionRequest,
  postToolBatch,
  postToolUse,
  preToolUse,
  sessionEnd,
  sessionStart,
  stop,
  userPromptSubmit,
} from '../support/fake-agent/hook-events.ts';

const session = {
  sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
  cwd: '/work/unit',
  transcriptPath: '/config/projects/-work-unit/6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11.jsonl',
  permissionMode: 'default',
};
const call = { id: 'toolu_fake_1', name: 'Bash', input: { command: 'touch a.txt' } };

describe("the payloads of the fake agent's hooks", () => {
  it('carry the session, its folder, its transcript, its mode and the event (behavior 1)', () => {
    expect(payloadOf(session, stop('Done.'))).toMatchObject({
      session_id: session.sessionId,
      cwd: '/work/unit',
      transcript_path: session.transcriptPath,
      permission_mode: 'default',
      hook_event_name: 'Stop',
    });
  });

  it.each([
    ['SessionStart', sessionStart({ source: 'startup', model: 'haiku' })],
    ['SessionEnd', sessionEnd('other')],
  ])('%s carries no mode', (_event, hookEvent) => {
    expect(payloadOf(session, hookEvent)).not.toHaveProperty('permission_mode');
  });

  it('carry the effort for a tool call, its ask, its end, its batch and the end of the turn only', () => {
    const withEffort = [
      preToolUse(call),
      permissionRequest(call),
      postToolUse(call, {}),
      postToolBatch(call, ''),
      stop('Done.'),
    ];
    const without = [
      sessionStart({ source: 'startup', model: 'haiku' }),
      userPromptSubmit('hello'),
      messageDisplay({ turnId: 'turn-1', messageId: 'message-1', text: 'Done.' }),
      sessionEnd('other'),
    ];

    for (const hookEvent of withEffort) {
      expect(payloadOf(session, hookEvent)).toMatchObject({ effort: { level: 'medium' } });
    }
    for (const hookEvent of without) {
      expect(payloadOf(session, hookEvent)).not.toHaveProperty('effort');
    }
  });

  it('carry the id of the last prompt once one was taken', () => {
    expect(payloadOf(session, stop('Done.'))).not.toHaveProperty('prompt_id');
    expect(payloadOf(session, afterPrompt('prompt-1', stop('Done.')))).toMatchObject({
      prompt_id: 'prompt-1',
      last_assistant_message: 'Done.',
    });
  });

  it('SessionStart of a new session names its model', () => {
    expect(payloadOf(session, sessionStart({ source: 'startup', model: 'haiku' }))).toEqual({
      session_id: session.sessionId,
      cwd: '/work/unit',
      transcript_path: session.transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'haiku',
    });
  });

  it('SessionStart of a resumed session says what going on costs, when the agent answered before', () => {
    const answeredBefore = sessionStart({ source: 'resume', secondsSinceLastResponse: 7 });
    const neverAnswered = sessionStart({ source: 'resume', secondsSinceLastResponse: undefined });

    expect(answeredBefore.fields).toEqual({
      source: 'resume',
      seconds_since_last_response: 7,
      context_tokens: 0,
      prompt_cache_likely_expired: false,
      estimated_cache_write_usd: 0,
    });
    expect(neverAnswered.fields).toEqual({ source: 'resume' });
  });

  it('UserPromptSubmit carries the prompt (behavior 5)', () => {
    expect(payloadOf(session, userPromptSubmit('hello'))).toMatchObject({ prompt: 'hello' });
  });

  it('PreToolUse carries the tool, its input and the id of the call', () => {
    expect(payloadOf(session, preToolUse(call))).toMatchObject({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'touch a.txt' },
      tool_use_id: 'toolu_fake_1',
    });
  });

  it('PermissionRequest carries the tool and its input, and no id of the call', () => {
    const payload = payloadOf(session, permissionRequest(call));

    expect(payload).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'touch a.txt' } });
    expect(payload).not.toHaveProperty('tool_use_id');
    expect(payload).not.toHaveProperty('permission_suggestions');
  });

  it('PermissionRequest carries the suggestions of the ask, when it has any', () => {
    const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];

    expect(permissionRequest(call, suggestions).fields).toMatchObject({
      permission_suggestions: suggestions,
    });
  });

  it('PostToolUse carries the id of its PreToolUse and what the tool answered (behavior 10)', () => {
    expect(payloadOf(session, postToolUse(call, { stdout: '' }))).toMatchObject({
      tool_name: 'Bash',
      tool_use_id: 'toolu_fake_1',
      tool_response: { stdout: '' },
      duration_ms: 0,
    });
  });

  it('PostToolBatch carries the call as the model made it, and what the model is told of it', () => {
    expect(postToolBatch(call, '(Bash completed with no output)').fields).toEqual({
      tool_calls: [
        {
          tool_name: 'Bash',
          tool_input: { command: 'touch a.txt' },
          tool_use_id: 'toolu_fake_1',
          tool_response: '(Bash completed with no output)',
        },
      ],
    });
  });

  it('Stop carries the last message of the turn, and nothing left running (behavior 7)', () => {
    expect(stop('Done.').fields).toEqual({
      stop_hook_active: false,
      last_assistant_message: 'Done.',
      background_tasks: [],
      session_crons: [],
    });
  });

  it('MessageDisplay carries a whole message as its one and last part, its turn, and no mode', () => {
    const shown = messageDisplay({ turnId: 'turn-1', messageId: 'message-1', text: 'Done.' });

    expect(payloadOf(session, shown)).toEqual({
      session_id: session.sessionId,
      cwd: '/work/unit',
      transcript_path: session.transcriptPath,
      hook_event_name: 'MessageDisplay',
      turn_id: 'turn-1',
      message_id: 'message-1',
      index: 0,
      final: true,
      delta: 'Done.',
    });
  });

  it('SessionEnd carries the reason', () => {
    expect(payloadOf(session, sessionEnd('other'))).toMatchObject({ reason: 'other' });
  });
});

describe('what the hooks answered, as the fake agent reads it', () => {
  const updatedInput = { questions: [], answers: { 'Which?': 'A' } };
  const beforeTheCall = (specific: object) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', ...specific },
  });
  const asked = (decision: object) => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });

  it.each(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop'])(
    'reads no decision from no answer or an empty one of %s',
    (event) => {
      expect(decisionOf(event, [])).toEqual({ behavior: 'none' });
      expect(decisionOf(event, [{}, {}])).toEqual({ behavior: 'none' });
    },
  );

  it("reads a PreToolUse hook's allow, with the input it gives (behavior 13)", () => {
    expect(decisionOf('PreToolUse', [beforeTheCall({ permissionDecision: 'allow' })])).toEqual({
      behavior: 'allow',
      updatedInput: undefined,
    });
    expect(
      decisionOf('PreToolUse', [beforeTheCall({ permissionDecision: 'allow', updatedInput })]),
    ).toEqual({ behavior: 'allow', updatedInput });
  });

  it.each(['deny', 'ask', 'defer', 7])(
    "refuses to read a PreToolUse hook's %j: nothing tells what Claude Code does with it",
    (permissionDecision) => {
      expect(() => decisionOf('PreToolUse', [{}, beforeTheCall({ permissionDecision })])).toThrow(
        `a PreToolUse hook answered ${JSON.stringify(permissionDecision)}`,
      );
    },
  );

  it("reads a PermissionRequest hook's allow, with or without an input (behavior 9)", () => {
    expect(decisionOf('PermissionRequest', [asked({ behavior: 'allow' })])).toEqual({
      behavior: 'allow',
      updatedInput: undefined,
    });
    expect(decisionOf('PermissionRequest', [asked({ behavior: 'allow', updatedInput })])).toEqual({
      behavior: 'allow',
      updatedInput,
    });
  });

  it("reads a PermissionRequest hook's deny, its message and whether it interrupts the turn (behavior 26)", () => {
    expect(decisionOf('PermissionRequest', [asked({ behavior: 'deny', message: 'No.' })])).toEqual({
      behavior: 'deny',
      interrupts: false,
      message: 'No.',
    });
    expect(decisionOf('PermissionRequest', [asked({ behavior: 'deny', interrupt: true })])).toEqual(
      { behavior: 'deny', interrupts: true, message: undefined },
    );
  });

  it('takes the first decision among several answers', () => {
    const answers = [{}, asked({ behavior: 'deny' }), asked({ behavior: 'allow' })];

    expect(decisionOf('PermissionRequest', answers)).toMatchObject({ behavior: 'deny' });
  });

  it.each([
    ['an answer that is no object', 'Stop', 'text', /a Stop hook answered what is no object/],
    ['a null answer', 'Stop', null, /a Stop hook answered what is no object/],
    [
      'a turn kept from ending',
      'Stop',
      { decision: 'block', reason: 'Go on.' },
      /Stop.*"decision"/,
    ],
    ['a prompt blocked', 'UserPromptSubmit', { decision: 'block' }, /UserPromptSubmit.*"decision"/],
    ['a session stopped', 'PostToolUse', { continue: false }, /PostToolUse.*"continue"/],
    [
      'context for the model',
      'SessionStart',
      { hookSpecificOutput: { additionalContext: 'x' } },
      /SessionStart.*"hookSpecificOutput"/,
    ],
    [
      'a reason beside an allow',
      'PreToolUse',
      beforeTheCall({ permissionDecision: 'allow', permissionDecisionReason: 'Fine.' }),
      /PreToolUse.*"permissionDecisionReason"/,
    ],
    [
      "another event's name",
      'PreToolUse',
      asked({ behavior: 'allow' }),
      /PreToolUse.*"PermissionRequest"/,
    ],
    [
      "another event's decision",
      'PermissionRequest',
      { hookSpecificOutput: { permissionDecision: 'allow' } },
      /PermissionRequest.*"permissionDecision"/,
    ],
    [
      'permissions to remember',
      'PermissionRequest',
      asked({ behavior: 'allow', updatedPermissions: [] }),
      /PermissionRequest.*"updatedPermissions"/,
    ],
    [
      'an allow that interrupts',
      'PermissionRequest',
      asked({ behavior: 'allow', interrupt: true }),
      /PermissionRequest.*"interrupt"/,
    ],
    [
      'a deny with another input',
      'PermissionRequest',
      asked({ behavior: 'deny', updatedInput }),
      /PermissionRequest.*"updatedInput"/,
    ],
    [
      'a behavior that is neither',
      'PermissionRequest',
      asked({ behavior: 'ask' }),
      /PermissionRequest.*"ask"/,
    ],
    [
      'a decision with no behavior',
      'PermissionRequest',
      asked({}),
      /PermissionRequest hook answered undefined/,
    ],
  ])('refuses to read %s: the fake agent does not play it', (_what, event, answer, problem) => {
    expect(() => decisionOf(event, [{}, answer])).toThrow(problem);
  });
});
