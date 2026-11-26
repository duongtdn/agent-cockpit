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

/** The session takes input: it started (`startup`) or was resumed (`resume`). */
export function sessionStart(source: 'startup' | 'resume'): HookEvent {
  return event('SessionStart', { source });
}

/** A prompt was taken. */
export function userPromptSubmit(prompt: string): HookEvent {
  return event('UserPromptSubmit', { prompt });
}

/** A tool call is about to run. */
export function preToolUse(call: ToolCall): HookEvent {
  return toolEvent('PreToolUse', call, { tool_input: call.input, tool_use_id: call.id });
}

/** A tool call asks for permission. It does not carry the call's id. */
export function permissionRequest(call: ToolCall): HookEvent {
  return toolEvent('PermissionRequest', call, { tool_input: call.input });
}

/** A tool call ran, and answered `response`. */
export function postToolUse(call: ToolCall, response: unknown): HookEvent {
  return toolEvent('PostToolUse', call, {
    tool_input: call.input,
    tool_response: response,
    tool_use_id: call.id,
  });
}

/** The turn ended with this last message of the agent's. */
export function stop(lastAssistantMessage: string): HookEvent {
  return event('Stop', { last_assistant_message: lastAssistantMessage });
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

/** The events whose payload, seen of Claude Code, carries no permission mode. */
const EVENTS_WITHOUT_THE_MODE: readonly string[] = ['MessageDisplay'];

/**
 * Builds the payload a hook receives for an event.
 *
 * @param session - The session the event happened in.
 * @param hookEvent - The event.
 * @returns The payload, with Claude Code's field names.
 */
export function payloadOf(session: SessionContext, hookEvent: HookEvent): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    transcript_path: session.transcriptPath,
    cwd: session.cwd,
    ...(EVENTS_WITHOUT_THE_MODE.includes(hookEvent.name)
      ? {}
      : { permission_mode: session.permissionMode }),
    hook_event_name: hookEvent.name,
    ...hookEvent.fields,
  };
}
