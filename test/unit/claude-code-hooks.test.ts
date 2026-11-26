import { describe, expect, it } from 'vitest';
import { HTTP_HOOK_EVENTS, readHook } from '../../src/claude-code/hook-payloads.ts';
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

function eventsOfPayload(body: unknown) {
  return readHook({ key: 'chapter-1', path: HOOKS_PATH, body }).events;
}

/**
 * The hooks the fake agent does not play yet, with the fields the pinned
 * Claude Code's hook input declares for them, and their values as the spikes
 * saw them.
 */
function stopFailure(error: unknown, message?: string): HookEvent {
  return {
    name: 'StopFailure',
    fields: {
      error,
      ...(message === undefined ? {} : { last_assistant_message: message }),
    },
  };
}
const preCompact: HookEvent = {
  name: 'PreCompact',
  fields: { trigger: 'manual', custom_instructions: '' },
};
const postCompact: HookEvent = {
  name: 'PostCompact',
  fields: { trigger: 'manual', compact_summary: 'The conversation so far.' },
};
const reviewer = { agent_id: 'a5f2c9e1b7d34', agent_type: 'general-purpose' };
const subagentStart: HookEvent = { name: 'SubagentStart', fields: reviewer };
const subagentStop: HookEvent = {
  name: 'SubagentStop',
  fields: {
    stop_hook_active: false,
    ...reviewer,
    agent_transcript_path: '/config/projects/-work/s/subagents/agent-a5f2c9e1b7d34.jsonl',
    last_assistant_message: 'Reviewed.',
    background_tasks: [],
  },
};

/** A task of `Stop`'s `background_tasks`, as Claude Code lists a subagent. */
const runningReviewer = {
  id: reviewer.agent_id,
  type: 'subagent',
  status: 'running',
  description: 'Review a.ts',
  agent_type: reviewer.agent_type,
};

function stopWithTasks(tasks: unknown): HookEvent {
  const ended = stop('Started a review.');
  return { name: ended.name, fields: { ...ended.fields, background_tasks: tasks } };
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

  it('Stop: the turn ended, with its last message, and no task runs in the background', () => {
    expect(eventsOf(afterPrompt('p1', stop('Done.')))).toEqual([
      { type: 'turn-ended', lastMessage: 'Done.' },
      { type: 'tasks', running: [] },
    ]);
  });

  it('Stop with no last message: the turn ended, with none', () => {
    const body = { ...payloadOf(session, stop('')), last_assistant_message: undefined };

    expect(eventsOfPayload(body)).toEqual([{ type: 'turn-ended' }, { type: 'tasks', running: [] }]);
  });

  it('Stop with tasks in the background: each listed, a subagent by its type', () => {
    const shell = {
      id: 'b8k2m4',
      type: 'shell',
      status: 'running',
      description: 'Run the tests',
      command: 'npm test',
    };

    expect(eventsOf(stopWithTasks([runningReviewer, shell]))[1]).toEqual({
      type: 'tasks',
      running: [
        { id: reviewer.agent_id, type: 'general-purpose', description: 'Review a.ts' },
        { id: 'b8k2m4', type: 'shell', description: 'Run the tests' },
      ],
    });
  });

  it('Stop lists no task it cannot name, and no description that says nothing', () => {
    const unnamed = { type: 'subagent', status: 'running', description: 'x' };
    const silent = { id: 'c1', type: 'monitor', status: 'pending', description: '' };

    expect(eventsOf(stopWithTasks([unnamed, silent, 'task', null]))[1]).toEqual({
      type: 'tasks',
      running: [{ id: 'c1', type: 'monitor' }],
    });
  });

  it('Stop that lists no tasks at all tells only the end of the turn', () => {
    const body = { ...payloadOf(session, stop('Done.')), background_tasks: undefined };

    expect(eventsOfPayload(body)).toEqual([{ type: 'turn-ended', lastMessage: 'Done.' }]);
  });

  it.each([
    ['server_error', 'server'],
    ['overloaded', 'server'],
    ['rate_limit', 'rate-limit'],
    ['unknown', 'other'],
    ['invalid_request', 'other'],
    ['billing_error', 'other'],
    ['constructor', 'other'],
    [undefined, 'other'],
  ])(
    'StopFailure on %s: the turn failed, its error of the kind %s, with its text',
    (error, kind) => {
      const message = 'API Error: 529 Overloaded. Resend your message to try again.';

      expect(eventsOf(afterPrompt('p1', stopFailure(error, message)))).toEqual([
        { type: 'turn-failed', error: { kind, message } },
      ]);
    },
  );

  it('StopFailure with no text: the error is named by its type', () => {
    expect(eventsOf(stopFailure('rate_limit'))).toEqual([
      { type: 'turn-failed', error: { kind: 'rate-limit', message: 'rate_limit' } },
    ]);
  });

  it('PreCompact and PostCompact: a compaction begins and ends', () => {
    expect(eventsOf(preCompact)).toEqual([{ type: 'compaction-began' }]);
    expect(eventsOf(postCompact)).toEqual([{ type: 'compaction-ended' }]);
  });

  it("SubagentStop: a background task finished, named by its agent_id, though it is the task's hook", () => {
    expect(eventsOf(subagentStop)).toEqual([{ type: 'task-finished', id: reviewer.agent_id }]);
  });

  it('SubagentStart, and a SubagentStop that names no task, tell nothing', () => {
    expect(eventsOf(subagentStart)).toEqual([]);
    const body = { ...payloadOf(session, subagentStop), agent_id: 7 };
    expect(eventsOfPayload(body)).toEqual([]);
  });

  it("a background task's own Stop, StopFailure or compaction tells nothing of the session", () => {
    for (const hookEvent of [stop('Done.'), stopFailure('server_error', 'x'), preCompact]) {
      expect(eventsOfPayload({ ...payloadOf(session, hookEvent), ...reviewer })).toEqual([]);
    }
  });

  it('SessionEnd after /exit: the agent exits by itself', () => {
    expect(eventsOf(afterPrompt('p1', sessionEnd('prompt_input_exit')))).toEqual([
      { type: 'ending', reason: 'agent-exit' },
    ]);
  });

  it('SessionEnd for any other reason: the session is lost', () => {
    expect(eventsOf(sessionEnd('other'))).toEqual([{ type: 'ending', reason: 'lost' }]);
  });

  it('SessionEnd of a /clear tells nothing: the process goes on, with a new conversation', () => {
    const body = { ...payloadOf(session, sessionEnd('other')), reason: 'clear' };

    expect(eventsOfPayload(body)).toEqual([]);
  });

  it('configures as HTTP hooks every event the driver reads but SessionStart', () => {
    expect([...HTTP_HOOK_EVENTS].sort()).toEqual(
      [
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'StopFailure',
        'PreCompact',
        'PostCompact',
        'SubagentStart',
        'SubagentStop',
        'SessionEnd',
      ].sort(),
    );
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
