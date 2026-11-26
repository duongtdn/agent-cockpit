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
 * same process going on.
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

/**
 * Reads a hook's payload as the core's events.
 *
 * A background task's hooks carry its `agent_id`, and never move the
 * session's state: they tell nothing, but the task's `SubagentStop`, which
 * tells that the task finished.
 *
 * @param request - The request, its token checked.
 * @returns The events it tells: none for a path that is not the hooks', a
 * body that is no payload, a hook the driver does not configure, and a
 * background task's hook.
 */
export function readHook(request: HookRequest): HookOutcome {
  const { path, body } = request;
  if (path !== HOOKS_PATH || !isRecord(body)) return NOTHING;
  if (body.hook_event_name === 'SubagentStop') return { events: taskFinished(body.agent_id) };
  if (body.agent_id !== undefined) return NOTHING;
  return { events: eventsOf(body) };
}

function eventsOf(payload: Record<string, unknown>): DriverEvent[] {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return LAUNCH_SOURCES.includes(payload.source) ? [{ type: 'ready' }] : [];
    case 'UserPromptSubmit':
      return [{ type: 'prompt-taken' }];
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
