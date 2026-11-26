import { describe, expect, it } from 'vitest';
import { decisionOf } from '../support/fake-agent/hook-decisions.ts';
import {
  payloadOf,
  permissionRequest,
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

  it('SessionStart says whether the session started or resumed', () => {
    expect(payloadOf(session, sessionStart('resume'))).toMatchObject({
      hook_event_name: 'SessionStart',
      source: 'resume',
    });
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
  });

  it('PostToolUse carries the id of its PreToolUse and what the tool answered (behavior 10)', () => {
    expect(payloadOf(session, postToolUse(call, { stdout: '' }))).toMatchObject({
      tool_name: 'Bash',
      tool_use_id: 'toolu_fake_1',
      tool_response: { stdout: '' },
    });
  });

  it('Stop carries the last message of the turn (behavior 7)', () => {
    expect(payloadOf(session, stop('Done.'))).toMatchObject({ last_assistant_message: 'Done.' });
  });

  it('SessionEnd carries the reason', () => {
    expect(payloadOf(session, sessionEnd('other'))).toMatchObject({ reason: 'other' });
  });

  it('tool events name their tool, for the matchers; the others name none', () => {
    expect(preToolUse(call).toolName).toBe('Bash');
    expect(stop('Done.').toolName).toBeUndefined();
  });
});

describe('what the hooks answered, as the fake agent reads it', () => {
  const updatedInput = { questions: [], answers: { 'Which?': 'A' } };

  it('reads no decision from no answer, an empty one or one that is no object', () => {
    expect(decisionOf([])).toEqual({ behavior: 'none' });
    expect(decisionOf([{}, null, 'text'])).toEqual({ behavior: 'none' });
  });

  it("reads a PreToolUse hook's allow, with the input it gives (behavior 13)", () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput,
      },
    };

    expect(decisionOf([output])).toEqual({ behavior: 'allow', updatedInput });
  });

  it("reads a PermissionRequest hook's allow, with or without an input (behavior 9)", () => {
    const allow = (decision: object) => ({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
    });

    expect(decisionOf([allow({ behavior: 'allow' })])).toEqual({
      behavior: 'allow',
      updatedInput: undefined,
    });
    expect(decisionOf([allow({ behavior: 'allow', updatedInput })])).toEqual({
      behavior: 'allow',
      updatedInput,
    });
  });

  it("reads a PermissionRequest hook's deny, and whether it interrupts the turn", () => {
    const deny = (decision: object) => ({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
    });

    expect(decisionOf([deny({ behavior: 'deny', message: 'No.' })])).toEqual({
      behavior: 'deny',
      interrupts: false,
    });
    expect(decisionOf([deny({ behavior: 'deny', interrupt: true })])).toEqual({
      behavior: 'deny',
      interrupts: true,
    });
  });

  it('takes the first decision among several answers', () => {
    const deny = { hookSpecificOutput: { decision: { behavior: 'deny' } } };
    const allow = { hookSpecificOutput: { decision: { behavior: 'allow' } } };

    expect(decisionOf([{}, deny, allow])).toEqual({ behavior: 'deny', interrupts: false });
  });
});
