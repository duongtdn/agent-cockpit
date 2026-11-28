import { type CallOutcome, callOutcome } from '../hooks/payload-recording.ts';
import type { ShapeChoice } from '../recorded-hooks.ts';
import type { HookRunner } from './hook-runner.ts';
import type { AskedCall, Step, TerminalAnswer, TurnStep } from './script.ts';
import type { Transcript } from './transcript.ts';

/** The status the fake agent exits with when it is asked to play what it does not. */
export const CANNOT_PLAY_STATUS = 70;

/** The status of a process ended by SIGTERM, as Claude Code exits on it. */
export const TERMINATED_STATUS = 143;

/** The `SessionEnd` reason of an agent that exits by itself, seen of Claude Code on `/exit`. */
const OWN_EXIT_REASON = 'prompt_input_exit';

/** The `SessionEnd` reason of an agent ended by a signal, seen of Claude Code on SIGTERM. */
const SIGNAL_REASON = 'other';

/** What the fake agent is made of: its session, its script, and the world around it. */
export interface FakeAgentParts {
  /** The launch's prompt, the only one it takes; none for a launch with none. */
  readonly prompt: string | undefined;
  /** What it plays, in order. */
  readonly steps: readonly Step[];
  /** The hooks of its settings. */
  readonly hooks: HookRunner;
  /**
   * Gives a payload the real agent sent, as recorded, filled with this
   * session's values (see `recordedPayload`).
   */
  readonly recorded: (event: string, where?: ShapeChoice) => Record<string, unknown>;
  /** Its conversation's transcript. */
  readonly transcript: Transcript;
  /** Waits until the test releases it from a `hold`. */
  readonly released: () => Promise<void>;
  /**
   * Waits until the test answers an ask as the person would in the
   * terminal; rejects once `signal` is aborted, when the ask was answered
   * otherwise.
   */
  readonly answeredInTerminal: (signal: AbortSignal) => Promise<TerminalAnswer>;
  /** Ends the process with a status. */
  readonly exit: (status: number) => never;
}

/** A fake agent: it fires recorded hooks as its script says, and draws nothing. */
export interface FakeAgent {
  /** Takes input, `SessionStart`, then plays the script. */
  start(): Promise<void>;
  /** Ends as on SIGTERM: `SessionEnd`, then the status of a terminated process. */
  terminate(): Promise<void>;
}

/** A session's own payloads: a subagent's carry its `agent_id`. */
export const OF_THE_SESSION: ShapeChoice = (payload) => !('agent_id' in payload);

/** The `Stop` of the session's turn that leaves no task running in the background. */
export const STOP_WITH_NO_TASK: ShapeChoice = (payload) =>
  !('agent_id' in payload) &&
  Array.isArray(payload.background_tasks) &&
  payload.background_tasks.length === 0;

/**
 * A session's own payloads of a call of a tool: the shape recorded for that
 * tool, outside any subagent.
 *
 * @param tool - The tool's name.
 */
export const ofTheCall =
  (tool: string): ShapeChoice =>
  (payload) =>
    OF_THE_SESSION(payload) && payload.tool_name === tool;

/**
 * The session's own `PostToolBatch` whose calls all ended one way.
 *
 * @param outcome - How they ended: ran, refused in the terminal with a
 * text, or denied by the hook.
 */
export const batchWhoseCalls =
  (outcome: CallOutcome): ShapeChoice =>
  (payload) =>
    OF_THE_SESSION(payload) &&
    Array.isArray(payload.tool_calls) &&
    payload.tool_calls.every(
      (call: { tool_response?: unknown }) => callOutcome(call.tool_response) === outcome,
    );

/** The hooks of one asked call, each fired when the call gets that far. */
interface CallHooks {
  /** Fires its `PreToolUse`. */
  before(): Promise<void>;
  /** Gives its `PermissionRequest`, for the caller to fire and hold. */
  permission(): Record<string, unknown>;
  /** Fires its `PostToolUse`, then the `PostToolBatch` of a call that ran. */
  ran(): Promise<void>;
  /** Fires the `PostToolBatch` of a call the hook denied, the deny's message its result if it gave one. */
  denied(message: string | undefined): Promise<void>;
  /** Fires the `PostToolBatch` of a call the person refused with a text. */
  refused(): Promise<void>;
}

/** How an ask's turn goes on: to its next ask and its end, or ended as an interruption. */
type AskOutcome = 'went-on' | 'interrupted';

/** What decides an ask first: the hook's reply, or the person in the terminal. */
type FirstAnswer =
  | { readonly by: 'hook'; readonly decision: PermissionDecision }
  | { readonly by: 'terminal'; readonly answer: TerminalAnswer };

/** The decision a `PermissionRequest` hook's reply carries, as Claude Code reads it. */
interface PermissionDecision {
  readonly behavior: 'allow' | 'deny';
  /** A deny's message, which the agent gives the model as the call's result. */
  readonly message?: string;
  readonly interrupt?: boolean;
}

/**
 * Creates a fake agent. Every payload it fires is one the contract suite
 * recorded of the real agent, with its session's values, the prompt and the
 * reply put in; nothing else is written here.
 *
 * @param parts - See {@link FakeAgentParts}.
 * @returns The agent, not started.
 */
export function createFakeAgent(parts: FakeAgentParts): FakeAgent {
  const { hooks, recorded, transcript } = parts;

  async function fire(payload: Record<string, unknown>): Promise<void> {
    await hooks.fire(payload);
  }

  /** Takes the prompt, and gives the prompt's id, which every hook of its turn carries. */
  async function takePrompt(prompt: string): Promise<unknown> {
    // Written first: a conversation that took a prompt is kept, however soon the process is killed.
    transcript.recordPrompt(prompt);
    const submitted: Record<string, unknown> = {
      ...recorded('UserPromptSubmit', OF_THE_SESSION),
      prompt,
    };
    await fire(submitted);
    return submitted.prompt_id;
  }

  async function turn(prompt: string, step: TurnStep): Promise<void> {
    const promptId = await takePrompt(prompt);
    for (const call of step.asks ?? []) {
      if ((await ask(hooksOfCall(call, promptId))) === 'interrupted') return;
    }
    transcript.recordReply(step.reply);
    await fire({ ...recorded('Stop', STOP_WITH_NO_TASK), last_assistant_message: step.reply });
  }

  /**
   * Builds a call's hooks from the recorded payloads, given its tool and
   * input, its turn's prompt id and its `PreToolUse`'s `tool_use_id`, as
   * one call's hooks carry them.
   */
  function hooksOfCall(call: AskedCall, promptId: unknown): CallHooks {
    const ofThisCall = (event: string) => ({
      ...recorded(event, ofTheCall(call.tool)),
      tool_input: call.input,
      prompt_id: promptId,
    });
    const before = ofThisCall('PreToolUse');
    const { tool_use_id } = before as Record<string, unknown>;
    const batch = (outcome: CallOutcome, result: Record<string, unknown> = {}) => {
      const recordedBatch = recorded('PostToolBatch', batchWhoseCalls(outcome));
      const [recordedCall] = recordedBatch.tool_calls as Record<string, unknown>[];
      const ofTheBatch = { tool_name: call.tool, tool_input: call.input, tool_use_id };
      return fire({
        ...recordedBatch,
        prompt_id: promptId,
        tool_calls: [{ ...recordedCall, ...ofTheBatch, ...result }],
      });
    };
    return {
      before: () => fire(before),
      permission: () => ofThisCall('PermissionRequest'),
      ran: async () => {
        await fire({ ...ofThisCall('PostToolUse'), tool_use_id });
        await batch('ran');
      },
      denied: (message: string | undefined) =>
        batch('denied', message === undefined ? {} : { tool_response: message }),
      refused: () => batch('refused'),
    };
  }

  /** Asks for a call and follows the answer, the hook's or the person's in the terminal. */
  async function ask(hooksOf: CallHooks): Promise<AskOutcome> {
    await hooksOf.before();
    const letGo = new AbortController();
    const holding = hooks.fire(hooksOf.permission(), letGo.signal);
    const first = await firstAnswer(holding);
    if (first.by === 'hook') return followDecision(first.decision, hooksOf);
    switch (first.answer) {
      case 'esc':
        letGo.abort();
        await holding;
        return interrupted();
      case 'yes':
        await hooksOf.ran();
        return 'went-on';
      case 'amended-no':
        await hooksOf.refused();
        return 'went-on';
    }
  }

  async function followDecision(
    decision: PermissionDecision,
    hooksOf: CallHooks,
  ): Promise<AskOutcome> {
    if (decision.behavior === 'allow') await hooksOf.ran();
    else if (decision.interrupt === true) return interrupted();
    else await hooksOf.denied(decision.message);
    return 'went-on';
  }

  /**
   * Waits for the hook's decision or the person's answer in the terminal,
   * whichever comes first. A reply with no decision leaves the dialog to the
   * person, as Claude Code does.
   */
  async function firstAnswer(holding: Promise<unknown[]>): Promise<FirstAnswer> {
    const watching = new AbortController();
    const inTerminal = parts
      .answeredInTerminal(watching.signal)
      .then((answer): FirstAnswer => ({ by: 'terminal', answer }));
    // It rejects once the watch is stopped, the hook having decided first.
    inTerminal.catch(() => {});
    const decided = holding.then((answers) => {
      const decision = answers.map(decisionIn).find((found) => found !== undefined);
      return decision === undefined ? inTerminal : { by: 'hook' as const, decision };
    });
    // Seen of Claude Code: what the hook does after the person answered is ignored.
    decided.catch(() => {});
    try {
      return await Promise.race([decided, inTerminal]);
    } finally {
      watching.abort();
    }
  }

  function interrupted(): AskOutcome {
    transcript.recordInterruption();
    return 'interrupted';
  }

  async function play(step: Step): Promise<void> {
    switch (step.do) {
      case 'turn':
        return turn(parts.prompt as string, step);
      case 'stay-busy':
        await takePrompt(parts.prompt as string);
        return;
      case 'hold':
        return parts.released();
      case 'exit':
        await fire(recorded('SessionEnd', { reason: OWN_EXIT_REASON }));
        return parts.exit(0);
    }
  }

  return {
    async start() {
      await fire(recorded('SessionStart', { source: 'startup' }));
      for (const step of parts.steps) await play(step);
    },
    async terminate() {
      await fire(recorded('SessionEnd', { reason: SIGNAL_REASON }));
      parts.exit(TERMINATED_STATUS);
    },
  };
}

/** Reads the decision of a `PermissionRequest` hook's reply; none for a reply that decides nothing. */
function decisionIn(reply: unknown): PermissionDecision | undefined {
  const decision = (reply as { hookSpecificOutput?: { decision?: unknown } } | null)
    ?.hookSpecificOutput?.decision as Partial<PermissionDecision> | undefined;
  return decision?.behavior === 'allow' || decision?.behavior === 'deny'
    ? (decision as PermissionDecision)
    : undefined;
}
