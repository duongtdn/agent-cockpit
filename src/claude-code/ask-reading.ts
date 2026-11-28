import type { AskContent, AskOfCall, DriverEvent, HookOutcome } from '../server/driver.js';

/**
 * The tools whose `PermissionRequest` asks no permission: a question
 * (`AskUserQuestion`) and a plan's approval (`ExitPlanMode`), which the
 * terminal shows as before.
 */
const NOT_PERMISSIONS: readonly unknown[] = ['AskUserQuestion', 'ExitPlanMode'];

/**
 * The `Notification`s of the agent asking a person in its terminal: the
 * panel of `auto`'s check (`agent_needs_input`), then the dialog
 * (`permission_prompt`).
 */
const ASKING_NOTIFICATIONS: readonly unknown[] = ['agent_needs_input', 'permission_prompt'];

/**
 * The mode in which every permission the agent asks comes through
 * `PermissionRequest`: its calls are never asked in the terminal alone,
 * which the agent does in `auto` and `plan`. Any other mode, one the
 * agent names otherwise included, may be.
 */
const ASKS_THROUGH_ITS_HOOK = 'default';

const NOTHING: HookOutcome = { events: [] };

/**
 * A tool call of the session's own, from its `PreToolUse` until its
 * `PostToolUse` or `PostToolUseFailure`.
 */
interface Call {
  readonly id: unknown;
  readonly identity: string;
  readonly promptId: unknown;
  readonly content: AskContent;
  /** Whether the agent may ask about it in its terminal alone, by the mode it was called in. */
  readonly askableInTerminal: boolean;
  /** Whether an ask was matched to it: by its `PermissionRequest`, or opened from a `Notification`. */
  asked: boolean;
}

/** An ask opened and not yet settled by a call finished. */
interface OpenAsk {
  readonly ref: string;
  readonly identity: string;
}

/** A session's unfinished calls and open asks, each in arrival order. */
interface Turn {
  calls: Call[];
  asks: OpenAsk[];
}

/**
 * Reads a hook of a session's own (no background task's) for its asks:
 * the ask it opens, and the events that settle one or open one in the
 * terminal.
 */
export type AskReader = (key: string, payload: Record<string, unknown>) => HookOutcome;

/**
 * Makes a reader of a driver's asks, which keeps, for each session, its
 * unfinished calls and its open asks, until its batch, its turn or its
 * process ends.
 *
 * A `PermissionRequest` carries no `tool_use_id`: its ask is matched to
 * the oldest unmatched `PreToolUse` of the same tool, input and turn
 * (`prompt_id`), which it follows. Identical calls are twins, which no
 * hook tells apart: a call finished settles the oldest open ask of its
 * tool and input, its own or a twin's, or one whose `PreToolUse` the
 * driver never read.
 *
 * @returns The reader: for a hook, the ask it opens (a permission of the
 * session's own) and the events it tells (`call-finished`, `batch-ended`,
 * `asked-in-terminal`); none for any other hook.
 */
export function createAskReader(): AskReader {
  const turns = new Map<string, Turn>();
  let refsMade = 0;
  const openAsk = (turn: Turn, identity: string, content: AskContent): AskOfCall => {
    refsMade += 1;
    const ref = `call-${refsMade}`;
    turn.asks.push({ ref, identity });
    return { ref, content };
  };

  return (key, payload) => {
    const turn = turns.get(key) ?? { calls: [], asks: [] };
    const outcome = read(turn, payload, openAsk);
    if (turn.calls.length === 0 && turn.asks.length === 0) turns.delete(key);
    else turns.set(key, turn);
    return outcome;
  };
}

type AskOpener = (turn: Turn, identity: string, content: AskContent) => AskOfCall;

function read(turn: Turn, payload: Record<string, unknown>, openAsk: AskOpener): HookOutcome {
  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return callStarted(turn, payload);
    case 'PermissionRequest':
      return permissionAsked(turn, payload, openAsk);
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return callFinished(turn, payload);
    case 'Notification':
      return notified(turn, payload, openAsk);
    case 'PostToolBatch':
      // The next batch's calls come only after this hook's reply: whatever is open is this batch's.
      forget(turn);
      return { events: [{ type: 'batch-ended' }] };
    case 'UserPromptSubmit':
    case 'SessionStart':
    case 'SessionEnd':
      // A plain "No", an Esc or an interruption ends a turn with no hook for its calls.
      forget(turn);
      return NOTHING;
    default:
      return NOTHING;
  }
}

function callStarted(turn: Turn, payload: Record<string, unknown>): HookOutcome {
  const call = toolCall(payload);
  if (call !== undefined) {
    turn.calls.push({
      ...call,
      id: payload.tool_use_id,
      promptId: payload.prompt_id,
      askableInTerminal: payload.permission_mode !== ASKS_THROUGH_ITS_HOOK,
      asked: false,
    });
  }
  return NOTHING;
}

function permissionAsked(
  turn: Turn,
  payload: Record<string, unknown>,
  openAsk: AskOpener,
): HookOutcome {
  const asked = toolCall(payload);
  if (asked === undefined) return NOTHING;
  const call = turn.calls.find(
    (each) =>
      !each.asked && each.identity === asked.identity && each.promptId === payload.prompt_id,
  );
  // A question's or a plan's call is matched too: its Notification is no permission asked in the terminal.
  if (call !== undefined) call.asked = true;
  if (NOT_PERMISSIONS.includes(payload.tool_name)) return NOTHING;
  return { events: [], ask: openAsk(turn, asked.identity, asked.content) };
}

function callFinished(turn: Turn, payload: Record<string, unknown>): HookOutcome {
  const finished = toolCall(payload);
  if (finished === undefined) return NOTHING;
  turn.calls = turn.calls.filter((each) => each.id !== payload.tool_use_id);
  const settled = turn.asks.find((each) => each.identity === finished.identity);
  if (settled === undefined) return NOTHING;
  turn.asks = turn.asks.filter((each) => each !== settled);
  return { events: [{ type: 'call-finished', ref: settled.ref }] };
}

function notified(turn: Turn, payload: Record<string, unknown>, openAsk: AskOpener): HookOutcome {
  if (!ASKING_NOTIFICATIONS.includes(payload.notification_type)) return NOTHING;
  // A held ask's notice comes as a dialog's would: a call running in default mode is no ask.
  const call = turn.calls.find((each) => !each.asked && each.askableInTerminal);
  if (call === undefined) return NOTHING;
  call.asked = true;
  const event: DriverEvent = {
    type: 'asked-in-terminal',
    ask: openAsk(turn, call.identity, call.content),
  };
  return { events: [event] };
}

function forget(turn: Turn): void {
  turn.calls = [];
  turn.asks = [];
}

/**
 * A hook's tool call: what tells it from other calls (its tool and input)
 * and what an ask about it holds; none when the hook names no tool or
 * carries no input object.
 */
function toolCall(
  payload: Record<string, unknown>,
): { identity: string; content: AskContent } | undefined {
  const { tool_name: tool, tool_input: input } = payload;
  if (typeof tool !== 'string' || tool === '' || !isRecord(input)) return undefined;
  const { description } = input;
  const content: AskContent =
    typeof description === 'string' && description !== ''
      ? { kind: 'permission', tool, input, description }
      : { kind: 'permission', tool, input };
  return { identity: JSON.stringify([tool, sortedKeys(input)]), content };
}

/** A value with its objects' keys sorted, so that the same input reads the same in every hook. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((field) => [field, sortedKeys(value[field])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
