import { beforeEach, describe, expect, it } from 'vitest';
import { createHookReader, HTTP_HOOK_EVENTS } from '../../src/claude-code/hook-payloads.ts';
import { HOOKS_PATH } from '../../src/server/driver.ts';
import { recordedPayload, SAMPLE_VALUES, type ShapeChoice } from '../support/recorded-hooks.ts';

// Every payload is the pinned Claude Code's, as the contract suite recorded it; a test changes
// a field only to try the reader on a value of its own.
const session = SAMPLE_VALUES;

/** The recorded payload of an event, of the session's own (no subagent's) unless chosen otherwise. */
function payload(event: string, where?: ShapeChoice): Record<string, unknown> {
  return recordedPayload(event, where ?? ((each) => !('agent_id' in each)));
}

/** A background task's payload: its `agent_id` is what tells it from the session's. */
const ofATask: ShapeChoice = (each) => 'agent_id' in each;

/** A reader of one driver's hooks, anew for each test: it keeps what each session's hooks told of its tasks. */
let readHook: ReturnType<typeof createHookReader>;
beforeEach(() => {
  readHook = createHookReader();
});

function eventsOfPayload(body: unknown, path = HOOKS_PATH) {
  return readHook({ key: 'chapter-1', path, body }).events;
}

const subagentStart = () => payload('SubagentStart', ofATask);
/** The session's own `Agent` call, whose subagent runs in the background. */
const launchedInTheBackground = () =>
  payload('PostToolUse', (each) => each.tool_name === 'Agent' && !('agent_id' in each));
const subagentStop = () => payload('SubagentStop', (each) => each.agent_type !== '');
/** A Stop that lists tasks running in the background, of one kind. */
const stopListing = (kind: string) =>
  payload('Stop', (each) => JSON.stringify(each.background_tasks).includes(`"type":"${kind}"`));
/** Seen of Claude Code: a /compact that fails fires StopFailure with the agent_id of the
 * compaction's own agent, which no SubagentStart named. */
const compactionFailure = () => payload('StopFailure', ofATask);

describe("what Claude Code's hooks tell the core", () => {
  it.each([
    ['a new session', { source: 'startup' }],
    ['a resumed one', { source: 'resume' }],
  ])('SessionStart of %s: the agent is ready, in the conversation the hook names', (_, where) => {
    expect(eventsOfPayload(payload('SessionStart', where))).toEqual([
      { type: 'ready' },
      { type: 'conversation', conversationId: session.sessionId },
    ]);
  });

  it('SessionStart after a compaction is no start of the session: the conversation goes on', () => {
    expect(eventsOfPayload(payload('SessionStart', { source: 'compact' }))).toEqual([
      { type: 'conversation', conversationId: session.sessionId },
    ]);
  });

  it('SessionStart after a /clear names the new conversation, which the session goes on in', () => {
    const cleared = '779ad0f7-5a3c-4e0b-9d1f-2b6c8e4a7f10';
    const body = recordedPayload(
      'SessionStart',
      { source: 'clear' },
      { ...session, sessionId: cleared },
    );

    expect(eventsOfPayload(body)).toEqual([{ type: 'conversation', conversationId: cleared }]);
  });

  it('SessionStart that names no conversation tells only what its source does', () => {
    const body = { ...payload('SessionStart', { source: 'startup' }), session_id: '' };

    expect(eventsOfPayload(body)).toEqual([{ type: 'ready' }]);
  });

  it('UserPromptSubmit: a prompt was taken, as the agent took it', () => {
    const body = { ...payload('UserPromptSubmit'), prompt: 'Explain a.ts\nthen b.ts' };

    expect(eventsOfPayload(body)).toEqual([
      { type: 'prompt-taken', prompt: 'Explain a.ts\nthen b.ts' },
    ]);
  });

  it('UserPromptSubmit with no prompt of text: a prompt was taken, its text untold', () => {
    const { prompt: _, ...body } = payload('UserPromptSubmit');

    expect(eventsOfPayload(body)).toEqual([{ type: 'prompt-taken' }]);
    expect(eventsOfPayload({ ...body, prompt: 42 })).toEqual([{ type: 'prompt-taken' }]);
  });

  it('PreToolUse and PostToolUse of the session: it works on its turn', () => {
    expect(eventsOfPayload(payload('PreToolUse'))).toEqual([{ type: 'working' }]);
    expect(eventsOfPayload(payload('PostToolUse', { tool_name: 'Read' }))).toEqual([
      { type: 'working' },
    ]);
  });

  it("a background task's hooks change nothing: they carry its agent_id", () => {
    expect(eventsOfPayload(payload('PreToolUse', ofATask))).toEqual([]);
    expect(eventsOfPayload(payload('PostToolUse', ofATask))).toEqual([]);
  });

  it('Stop: the turn ended, with its last message, and no task runs in the background', () => {
    const body = payload(
      'Stop',
      (each) => `${each.background_tasks}` === '' && !('agent_id' in each),
    );

    expect(eventsOfPayload(body)).toEqual([
      { type: 'turn-ended', lastMessage: body.last_assistant_message },
      { type: 'tasks', running: [] },
    ]);
  });

  it('Stop with no last message: the turn ended, with none', () => {
    const body = { ...payload('Stop'), last_assistant_message: undefined, background_tasks: [] };

    expect(eventsOfPayload(body)).toEqual([{ type: 'turn-ended' }, { type: 'tasks', running: [] }]);
  });

  it('Stop with tasks in the background: each listed, a subagent by its type', () => {
    const [subagent] = stopListing('subagent').background_tasks as Record<string, string>[];
    const [shell] = stopListing('shell').background_tasks as Record<string, string>[];
    const body = { ...stopListing('subagent'), background_tasks: [subagent, shell] };

    expect(eventsOfPayload(body)[1]).toEqual({
      type: 'tasks',
      running: [
        { id: subagent?.id, type: subagent?.agent_type, description: subagent?.description },
        { id: shell?.id, type: 'shell', description: shell?.description },
      ],
    });
  });

  it('Stop lists no task it cannot name, and no description that says nothing', () => {
    const unnamed = { type: 'subagent', status: 'running', description: 'x' };
    const silent = { id: 'c1', type: 'monitor', status: 'pending', description: '' };
    const body = { ...payload('Stop'), background_tasks: [unnamed, silent, 'task', null] };

    expect(eventsOfPayload(body)[1]).toEqual({
      type: 'tasks',
      running: [{ id: 'c1', type: 'monitor' }],
    });
  });

  it('Stop that lists no tasks at all tells only the end of the turn', () => {
    const stop = payload('Stop');

    expect(eventsOfPayload({ ...stop, background_tasks: undefined })).toEqual([
      { type: 'turn-ended', lastMessage: stop.last_assistant_message },
    ]);
  });

  it.each([
    ['server_error', 'server'],
    ['rate_limit', 'rate-limit'],
    ['authentication_failed', 'other'],
  ])(
    'StopFailure on %s, as recorded: the turn failed, its error of the kind %s, with its text',
    (error, kind) => {
      const body = payload('StopFailure', (each) => each.error === error && !('agent_id' in each));

      expect(eventsOfPayload(body)).toEqual([
        { type: 'turn-failed', error: { kind, message: body.last_assistant_message } },
      ]);
    },
  );

  it.each([
    ['overloaded', 'server'],
    ['unknown', 'other'],
    ['invalid_request', 'other'],
    ['billing_error', 'other'],
    ['constructor', 'other'],
    [undefined, 'other'],
  ])('StopFailure on %s: the turn failed, its error of the kind %s', (error, kind) => {
    const failure = payload('StopFailure');

    expect(eventsOfPayload({ ...failure, error })).toEqual([
      { type: 'turn-failed', error: { kind, message: failure.last_assistant_message } },
    ]);
  });

  it('StopFailure with no text: the error is named by its type', () => {
    const { last_assistant_message: _, ...body } = payload('StopFailure', {
      error: 'rate_limit',
    });

    expect(eventsOfPayload(body)).toEqual([
      { type: 'turn-failed', error: { kind: 'rate-limit', message: 'rate_limit' } },
    ]);
  });

  it('PreCompact and PostCompact: a compaction begins and ends', () => {
    expect(eventsOfPayload(payload('PreCompact'))).toEqual([{ type: 'compaction-began' }]);
    expect(eventsOfPayload(payload('PostCompact'))).toEqual([{ type: 'compaction-ended' }]);
  });

  it("SubagentStop: a background task finished, named by its agent_id, though it is the task's hook", () => {
    const body = subagentStop();

    expect(eventsOfPayload(body)).toEqual([{ type: 'task-finished', id: body.agent_id }]);
  });

  it('PostToolUse of an Agent launched in the background: a background task started, as the end of a turn lists it', () => {
    const body = launchedInTheBackground();
    const [listed] = eventsOfPayload(stopListing('subagent')).filter(
      (event) => event.type === 'tasks',
    );

    expect(eventsOfPayload(body)).toEqual([
      { type: 'working' },
      { type: 'task-started', task: listed?.type === 'tasks' ? listed.running[0] : undefined },
    ]);
  });

  it('PostToolUse of an Agent that ran in the foreground: it works on its turn, no task', () => {
    const body = launchedInTheBackground();
    const ranInTheForeground = {
      ...body,
      tool_response: { ...(body.tool_response as object), isAsync: false },
    };

    expect(eventsOfPayload(ranInTheForeground)).toEqual([{ type: 'working' }]);
  });

  it('SubagentStart, and a SubagentStop that names no task, tell nothing', () => {
    expect(eventsOfPayload(subagentStart())).toEqual([]);
    expect(eventsOfPayload({ ...subagentStop(), agent_id: 7 })).toEqual([]);
  });

  it("a background task's own hooks tell nothing of the session: its tool calls, its StopFailure", () => {
    const task = subagentStart();
    eventsOfPayload(task);

    for (const body of [
      payload('PreToolUse', ofATask),
      payload('PostToolUse', ofATask),
      { ...compactionFailure(), agent_id: task.agent_id },
    ]) {
      expect(eventsOfPayload({ ...body, agent_id: task.agent_id })).toEqual([]);
    }
  });

  it('StopFailure carrying an agent_id that no SubagentStart named: the compaction failed, and ended', () => {
    expect(eventsOfPayload(compactionFailure())).toEqual([{ type: 'compaction-ended' }]);
  });

  it("StopFailure of a background task the driver knows, by its SubagentStart, tells nothing, before and after the task's end", () => {
    const task = subagentStart();
    eventsOfPayload(task);
    const taskFailure = { ...compactionFailure(), agent_id: task.agent_id };

    expect(eventsOfPayload(taskFailure)).toEqual([]);
    eventsOfPayload({ ...subagentStop(), agent_id: task.agent_id });
    expect(eventsOfPayload(taskFailure)).toEqual([]);
  });

  it("knows a session's tasks by its own hooks: another session's task is none of its", () => {
    const task = subagentStart();
    readHook({ key: 'chapter-2', path: HOOKS_PATH, body: task });

    expect(eventsOfPayload({ ...compactionFailure(), agent_id: task.agent_id })).toEqual([
      { type: 'compaction-ended' },
    ]);
  });

  it('forgets the tasks of a process that ended once its session starts again', () => {
    const task = subagentStart();
    eventsOfPayload(task);
    eventsOfPayload(payload('SessionEnd', { reason: 'other' }));
    eventsOfPayload(payload('SessionStart', { source: 'startup' }));

    expect(eventsOfPayload({ ...compactionFailure(), agent_id: task.agent_id })).toEqual([
      { type: 'compaction-ended' },
    ]);
  });

  it('SessionEnd after /exit: the agent exits by itself', () => {
    expect(eventsOfPayload(payload('SessionEnd', { reason: 'prompt_input_exit' }))).toEqual([
      { type: 'ending', reason: 'agent-exit' },
    ]);
  });

  it('SessionEnd for any other reason: the session is lost', () => {
    expect(eventsOfPayload(payload('SessionEnd', { reason: 'other' }))).toEqual([
      { type: 'ending', reason: 'lost' },
    ]);
  });

  it('SessionEnd of a /clear tells nothing: the process goes on, with a new conversation', () => {
    expect(eventsOfPayload(payload('SessionEnd', { reason: 'clear' }))).toEqual([]);
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
    expect(eventsOfPayload(payload('PostToolBatch'))).toEqual([]);
    expect(eventsOfPayload(payload('MessageDisplay'))).toEqual([]);
  });

  it('a request on another path, or with a body that is no payload, tells nothing', () => {
    expect(eventsOfPayload(payload('UserPromptSubmit'), '/mcp')).toEqual([]);
    expect(eventsOfPayload('Stop')).toEqual([]);
    expect(eventsOfPayload(null)).toEqual([]);
  });
});
