import {
  type DriverEvent,
  HOOKS_PATH,
  type HookOutcome,
  type HookRequest,
} from '../server/driver.js';
import type { BackgroundTask, TurnError } from '../shared/session.js';

/** The events posted to the cockpit as HTTP hooks: every one the driver reads but `SessionStart`. */
export const HTTP_HOOK_EVENTS: readonly string[] = [
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
];

/** What tells nothing. */
const NOTHING: HookOutcome = { events: [] };

/**
 * How a session came to take input that is the start of a launch. A
 * `SessionStart` of another source (after `/clear` or a compaction) is the
 * same process going on, in the conversation it names.
 */
const LAUNCH_SOURCES: readonly unknown[] = ['startup', 'resume'];

/** The `SessionEnd` reason of an agent that exited by itself (`/exit`). */
const EXIT_BY_ITSELF = 'prompt_input_exit';

/**
 * The `SessionEnd` reason of a `/clear`: the process goes on, under a new
 * conversation, and starts again with `SessionStart` (`source: clear`).
 */
const CLEARED = 'clear';

/**
 * The kinds of the agent's error types that apps act on apart; any other
 * type, or one added later, is `other`. `overloaded` is the provider's side,
 * as a 529 is.
 */
const ERROR_KINDS: ReadonlyMap<unknown, TurnError['kind']> = new Map([
  ['server_error', 'server'],
  ['overloaded', 'server'],
  ['rate_limit', 'rate-limit'],
]);

/** Reads a hook request of one of a driver's sessions as the core's events. */
export type HookReader = (request: HookRequest) => HookOutcome;

/**
 * Makes a reader of a driver's hooks, which keeps, for each session, the
 * background tasks its hooks told of: their `agent_id`s, from their
 * `SubagentStart`, until the session's process ends.
 *
 * A background task's hooks carry its `agent_id`, and never move the
 * session's state: they tell nothing, but the task's `SubagentStart`, which
 * tells that the task started, and its `SubagentStop`, which tells that it
 * finished. A compaction's own agent carries one too,
 * and starts with no `SubagentStart`: a `StopFailure` with an `agent_id` no
 * task of the session's has is the compaction's, which failed, and ended.
 *
 * @returns The reader: for a request, the events it tells, none for a path
 * that is not the hooks', a body that is no payload, a hook the driver does
 * not configure, and a background task's hook.
 */
export function createHookReader(): HookReader {
  const tasksBySession = new Map<string, Set<string>>();
  const tasksOf = (key: string) => tasksBySession.get(key) ?? new Set<string>();

  return ({ key, path, body }) => {
    if (path !== HOOKS_PATH || !isRecord(body)) return NOTHING;
    const { hook_event_name: name, agent_id: agentId } = body;
    if (name === 'SubagentStart' && isText(agentId)) {
      tasksBySession.set(key, tasksOf(key).add(agentId));
      return { events: [taskStarted(agentId, body.agent_type)] };
    }
    if (name === 'SubagentStop') return { events: taskFinished(agentId) };
    if (agentId !== undefined) {
      const compactionFailed = name === 'StopFailure' && !tasksOf(key).has(agentId as string);
      return compactionFailed ? { events: [{ type: 'compaction-ended' }] } : NOTHING;
    }
    if (startsAProcess(body) || endsTheProcess(body)) tasksBySession.delete(key);
    return { events: eventsOf(body) };
  };
}

/** Tells a `SessionStart` of a launch: a new process, which runs none of the tasks of one before. */
function startsAProcess(payload: Record<string, unknown>): boolean {
  return payload.hook_event_name === 'SessionStart' && LAUNCH_SOURCES.includes(payload.source);
}

/** Tells a `SessionEnd` of the process: one of a `/clear` is the same process going on. */
function endsTheProcess(payload: Record<string, unknown>): boolean {
  return payload.hook_event_name === 'SessionEnd' && payload.reason !== CLEARED;
}

function eventsOf(payload: Record<string, unknown>): DriverEvent[] {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return [
        ...(LAUNCH_SOURCES.includes(payload.source) ? [{ type: 'ready' } as const] : []),
        ...conversation(payload.session_id),
      ];
    case 'UserPromptSubmit':
      return [promptTaken(payload.prompt)];
    case 'PreToolUse':
    case 'PostToolUse':
      return [{ type: 'working' }];
    case 'Stop':
      return [turnEnded(payload.last_assistant_message), ...tasks(payload.background_tasks)];
    case 'StopFailure':
      return [{ type: 'turn-failed', error: turnError(payload) }];
    case 'PreCompact':
      return [{ type: 'compaction-began' }];
    case 'PostCompact':
      return [{ type: 'compaction-ended' }];
    case 'SessionEnd':
      return ending(payload.reason);
    default:
      return [];
  }
}

/**
 * The conversation a `SessionStart` names: after a `/clear` a new one, its
 * id the only place the agent tells it (its `SessionEnd` names the old).
 */
function conversation(id: unknown): DriverEvent[] {
  return isText(id) ? [{ type: 'conversation', conversationId: id }] : [];
}

/** A prompt taken, with its text when the payload carries it: what confirms a typed prompt. */
function promptTaken(prompt: unknown): DriverEvent {
  return typeof prompt === 'string' ? { type: 'prompt-taken', prompt } : { type: 'prompt-taken' };
}

function turnEnded(lastMessage: unknown): DriverEvent {
  return typeof lastMessage === 'string' && lastMessage !== ''
    ? { type: 'turn-ended', lastMessage }
    : { type: 'turn-ended' };
}

/**
 * The tasks `Stop` lists as in flight: none told when it lists none at all,
 * since then the agent says nothing of them.
 */
function tasks(listed: unknown): DriverEvent[] {
  if (!Array.isArray(listed)) return [];
  return [{ type: 'tasks', running: listed.flatMap(backgroundTask) }];
}

/**
 * A task as `Stop` lists it: a subagent named by its own type
 * (`general-purpose`), any other task by the agent's label for its kind
 * (`shell`, `monitor`, `workflow`). One without an id is left out: nothing
 * could name it again.
 */
function backgroundTask(entry: unknown): BackgroundTask[] {
  if (!isRecord(entry) || !isText(entry.id)) return [];
  const type = isText(entry.agent_type) ? entry.agent_type : isText(entry.type) ? entry.type : '';
  const task = { id: entry.id, type };
  return [isText(entry.description) ? { ...task, description: entry.description } : task];
}

function turnError(payload: Record<string, unknown>): TurnError {
  const { error, last_assistant_message: text } = payload;
  const kind = ERROR_KINDS.get(error) ?? 'other';
  const message = isText(text) ? text : typeof error === 'string' ? error : '';
  return { kind, message };
}

/** A background task started, named by its agent's type: its `SubagentStart` gives no description. */
function taskStarted(id: string, agentType: unknown): DriverEvent {
  return { type: 'task-started', task: { id, type: isText(agentType) ? agentType : '' } };
}

function taskFinished(id: unknown): DriverEvent[] {
  return isText(id) ? [{ type: 'task-finished', id }] : [];
}

function ending(reason: unknown): DriverEvent[] {
  if (reason === CLEARED) return [];
  return [{ type: 'ending', reason: reason === EXIT_BY_ITSELF ? 'agent-exit' : 'lost' }];
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
