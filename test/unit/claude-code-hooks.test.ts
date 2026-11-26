import { describe, expect, it } from 'vitest';
import { readHook } from '../../src/claude-code/hook-payloads.ts';
import { HOOKS_PATH } from '../../src/server/driver.ts';
import {
  afterPrompt,
  type HookEvent,
  messageDisplay,
  payloadOf,
  postToolBatch,
  postToolUse,
  preToolUse,
  sessionEnd,
  sessionStart,
  stop,
  userPromptSubmit,
} from '../support/fake-agent/hook-events.ts';

// The payloads are the fake agent's, which the parity test holds to the pinned Claude Code's.
const session = {
  sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
  cwd: '/work',
  transcriptPath: '/config/projects/-work/6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11.jsonl',
  permissionMode: 'default',
};
const touch = { id: 'toolu_01', name: 'Bash', input: { command: 'touch a.txt' } };

function eventsOf(hookEvent: HookEvent, path = HOOKS_PATH) {
  return readHook({ key: 'chapter-1', path, body: payloadOf(session, hookEvent) }).events;
}

describe("what Claude Code's hooks tell the core", () => {
  it.each([
    ['a new session', sessionStart({ source: 'startup', model: 'claude-haiku-4-5' })],
    ['a resumed one', sessionStart({ source: 'resume', secondsSinceLastResponse: 12 })],
    [
      'a resumed one with no answer yet',
      sessionStart({ source: 'resume', secondsSinceLastResponse: undefined }),
    ],
  ])('SessionStart of %s: the agent is ready', (_, hookEvent) => {
    expect(eventsOf(hookEvent)).toEqual([{ type: 'ready' }]);
  });

  it('SessionStart after a compaction or a clear is no start of the session', () => {
    expect(
      readHook({
        key: 'chapter-1',
        path: HOOKS_PATH,
        body: {
          ...payloadOf(session, sessionStart({ source: 'startup', model: 'm' })),
          source: 'compact',
        },
      }).events,
    ).toEqual([]);
  });

  it('UserPromptSubmit: a prompt was taken', () => {
    expect(eventsOf(userPromptSubmit('Explain a.ts'))).toEqual([{ type: 'prompt-taken' }]);
  });

  it('PreToolUse and PostToolUse of the session: it works on its turn', () => {
    expect(eventsOf(afterPrompt('p1', preToolUse(touch)))).toEqual([{ type: 'working' }]);
    expect(eventsOf(afterPrompt('p1', postToolUse(touch, {})))).toEqual([{ type: 'working' }]);
  });

  it("a background task's hooks change nothing: they carry its agent_id", () => {
    const body = {
      ...payloadOf(session, preToolUse(touch)),
      agent_id: 'a1',
      agent_type: 'general-purpose',
    };

    expect(readHook({ key: 'chapter-1', path: HOOKS_PATH, body }).events).toEqual([]);
  });

  it('Stop: the turn ended, with its last message', () => {
    expect(eventsOf(afterPrompt('p1', stop('Done.')))).toEqual([
      { type: 'turn-ended', lastMessage: 'Done.' },
    ]);
  });

  it('Stop with no last message: the turn ended, with none', () => {
    const body = { ...payloadOf(session, stop('')), last_assistant_message: undefined };

    expect(readHook({ key: 'chapter-1', path: HOOKS_PATH, body }).events).toEqual([
      { type: 'turn-ended' },
    ]);
  });

  it('SessionEnd after /exit: the agent exits by itself', () => {
    expect(eventsOf(afterPrompt('p1', sessionEnd('prompt_input_exit')))).toEqual([
      { type: 'ending', reason: 'agent-exit' },
    ]);
  });

  it('SessionEnd for any other reason: the session is lost', () => {
    expect(eventsOf(sessionEnd('other'))).toEqual([{ type: 'ending', reason: 'lost' }]);
  });

  it('the events the driver does not configure tell nothing', () => {
    expect(eventsOf(postToolBatch(touch, 'ok'))).toEqual([]);
    expect(eventsOf(messageDisplay({ turnId: 't', messageId: 'm', text: 'Hi' }))).toEqual([]);
  });

  it('a request on another path, or with a body that is no payload, tells nothing', () => {
    expect(eventsOf(userPromptSubmit('Hi'), '/mcp')).toEqual([]);
    expect(readHook({ key: 'chapter-1', path: HOOKS_PATH, body: 'Stop' }).events).toEqual([]);
    expect(readHook({ key: 'chapter-1', path: HOOKS_PATH, body: null }).events).toEqual([]);
  });
});
