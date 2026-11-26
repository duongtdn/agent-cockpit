/** What every hook payload says about its session. */
export interface SessionContext {
  /** The conversation's id. */
  readonly sessionId: string;
  /** The folder the session runs in. */
  readonly cwd: string;
  /** The file the conversation is written to. */
  readonly transcriptPath: string;
  /** The permission mode of the session. */
  readonly permissionMode: string;
}

/** The input of a tool call. */
export type ToolInput = Readonly<Record<string, unknown>>;

/** A tool call of the agent's. */
export interface ToolCall {
  /** The call's id, which its `PreToolUse` and `PostToolUse` share. */
  readonly id: string;
  /** The tool's name. */
  readonly name: string;
  /** What the tool is called with. */
  readonly input: ToolInput;
}

/** Something that happened in a session, as its hooks are told. */
export interface HookEvent {
  /** The event's name, as Claude Code names it. */
  readonly name: string;
  /** The fields that are the event's own. */
  readonly fields: Readonly<Record<string, unknown>>;
}

function event(name: string, fields: Readonly<Record<string, unknown>>): HookEvent {
  return { name, fields };
}

function toolEvent(
  name: string,
  call: ToolCall,
  fields: Readonly<Record<string, unknown>>,
): HookEvent {
  return event(name, { tool_name: call.name, ...fields });
}

/** How a session came to take input: started on a model, or resumed. */
export type Start =
  | {
      readonly source: 'startup';
      /** The model's name. Claude Code gives the full name of the model it resolved. */
      readonly model: string;
    }
  | {
      readonly source: 'resume';
      /** How long ago the agent last answered in the conversation; none when it never did. */
      readonly secondsSinceLastResponse: number | undefined;
    };

/**
 * The session takes input. Seen of Claude Code: a new session names its
 * model; a resumed one says what going on costs when the conversation holds
 * an answer of the agent's, and nothing more when it holds none.
 */
export function sessionStart(start: Start): HookEvent {
  if (start.source === 'startup') return event('SessionStart', { ...start });
  if (start.secondsSinceLastResponse === undefined) {
    return event('SessionStart', { source: start.source });
  }
  return event('SessionStart', {
    source: start.source,
    seconds_since_last_response: start.secondsSinceLastResponse,
    ...NO_MODEL_COSTS,
  });
}

/** What a resumed conversation costs a model to go on with, for an agent that has no model. */
const NO_MODEL_COSTS = {
  context_tokens: 0,
  prompt_cache_likely_expired: false,
  estimated_cache_write_usd: 0,
};

/** A prompt was taken. */
export function userPromptSubmit(prompt: string): HookEvent {
  return event('UserPromptSubmit', { prompt });
}

/** A tool call is about to run. */
export function preToolUse(call: ToolCall): HookEvent {
  return toolEvent('PreToolUse', call, { tool_input: call.input, tool_use_id: call.id });
}

/**
 * A tool call asks for permission. It does not carry the call's id.
 *
 * @param call - The call.
 * @param suggestions - The rules the dialog offers to add; left out for a
 * call whose ask, as seen of Claude Code, carries none: a question.
 */
export function permissionRequest(call: ToolCall, suggestions?: readonly object[]): HookEvent {
  return toolEvent('PermissionRequest', call, {
    tool_input: call.input,
    ...(suggestions === undefined ? {} : { permission_suggestions: suggestions }),
  });
}

/** A tool call ran, and answered `response`. */
export function postToolUse(call: ToolCall, response: unknown): HookEvent {
  return toolEvent('PostToolUse', call, {
    tool_input: call.input,
    tool_response: response,
    tool_use_id: call.id,
    // A call of the fake agent's runs nothing, and takes no time.
    duration_ms: 0,
  });
}

/**
 * The tool calls of one message of the model's are over, run or refused.
 * The fake agent's model calls one tool a message.
 *
 * @param call - The call, with the input the model gave it.
 * @param result - What the model is told of it: the tool's result, or why it did not run.
 */
export function postToolBatch(call: ToolCall, result: string): HookEvent {
  return event('PostToolBatch', {
    tool_calls: [
      {
        tool_name: call.name,
        tool_input: call.input,
        tool_use_id: call.id,
        tool_response: result,
      },
    ],
  });
}

/**
 * The turn ended with this last message of the agent's: for the first
 * time, with nothing left running in the background and nothing scheduled.
 */
export function stop(lastAssistantMessage: string): HookEvent {
  return event('Stop', {
    stop_hook_active: false,
    last_assistant_message: lastAssistantMessage,
    background_tasks: [],
    session_crons: [],
  });
}

/** A message of the agent's, as its turn and its text name it. */
export interface DisplayedMessage {
  /** The id of the turn the message is of. */
  readonly turnId: string;
  /** The message's own id. */
  readonly messageId: string;
  /** The text of the message: one line. */
  readonly text: string;
}

/**
 * A text of the agent's was shown. Seen of Claude Code for a text of one
 * line: it comes as one part, the first and the last. How a longer text is
 * cut into parts was not made out, so no such event is built here.
 */
export function messageDisplay(message: DisplayedMessage): HookEvent {
  return event('MessageDisplay', {
    turn_id: message.turnId,
    message_id: message.messageId,
    index: 0,
    final: true,
    delta: message.text,
  });
}

/** The session ends, for this reason. */
export function sessionEnd(reason: 'prompt_input_exit' | 'other'): HookEvent {
  return event('SessionEnd', { reason });
}

/**
 * Says of an event that it happened once a prompt was taken, as every
 * payload after the first prompt of a process does, the session's end too.
 *
 * @param promptId - The id of the last prompt taken.
 * @param hookEvent - The event.
 * @returns The event, with the prompt's id among its fields.
 */
export function afterPrompt(promptId: string, hookEvent: HookEvent): HookEvent {
  return event(hookEvent.name, { prompt_id: promptId, ...hookEvent.fields });
}

/** The events whose payload, seen of Claude Code, carries no permission mode. */
const EVENTS_WITHOUT_THE_MODE: readonly string[] = ['SessionStart', 'SessionEnd', 'MessageDisplay'];

/** The events whose payload, seen of Claude Code, carries the effort the model works with. */
const EVENTS_WITH_THE_EFFORT: readonly string[] = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolBatch',
  'Stop',
];

/** The effort seen of a session that was launched with none of its own. */
const EFFORT = { level: 'medium' };

/**
 * Builds the payload a hook receives for an event.
 *
 * @param session - The session the event happened in.
 * @param hookEvent - The event.
 * @returns The payload, with Claude Code's field names.
 */
export function payloadOf(session: SessionContext, hookEvent: HookEvent): Record<string, unknown> {
  const { name, fields } = hookEvent;
  return {
    session_id: session.sessionId,
    transcript_path: session.transcriptPath,
    cwd: session.cwd,
    ...(EVENTS_WITHOUT_THE_MODE.includes(name) ? {} : { permission_mode: session.permissionMode }),
    ...(EVENTS_WITH_THE_EFFORT.includes(name) ? { effort: EFFORT } : {}),
    hook_event_name: name,
    ...fields,
  };
}
