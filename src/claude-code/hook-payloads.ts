import {
  type DriverEvent,
  HOOKS_PATH,
  type HookOutcome,
  type HookRequest,
} from '../server/driver.js';

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
 * Reads a hook's payload as the core's events.
 *
 * @param request - The request, its token checked.
 * @returns The events it tells: none for a path that is not the hooks', a
 * body that is no payload, a hook the driver does not configure, and a
 * background task's hook (it carries `agent_id`), which never moves the
 * session's state.
 */
export function readHook(request: HookRequest): HookOutcome {
  const { path, body } = request;
  if (path !== HOOKS_PATH || !isRecord(body) || body.agent_id !== undefined) return NOTHING;
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
      return [turnEnded(payload.last_assistant_message)];
    case 'SessionEnd':
      return [
        { type: 'ending', reason: payload.reason === EXIT_BY_ITSELF ? 'agent-exit' : 'lost' },
      ];
    default:
      return [];
  }
}

function turnEnded(lastMessage: unknown): DriverEvent {
  return typeof lastMessage === 'string' && lastMessage !== ''
    ? { type: 'turn-ended', lastMessage }
    : { type: 'turn-ended' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
