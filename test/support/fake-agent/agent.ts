import { REFUSED_CALL } from '../hooks/payload-recording.ts';
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

/** The session's own `PostToolBatch` of a batch whose call the person refused with a text. */
export const REFUSED_BATCH: ShapeChoice = (payload) =>
  OF_THE_SESSION(payload) &&
  Array.isArray(payload.tool_calls) &&
  payload.tool_calls.some(
    (call: { tool_response?: unknown }) =>
      typeof call.tool_response === 'string' && call.tool_response.startsWith(REFUSED_CALL),
  );

/** How an ask's turn goes on: to its next ask and its end, or ended as an interruption. */
type AskOutcome = 'went-on' | 'interrupted';

/** What decides an ask first: the hook's reply, or the person in the terminal. */
type FirstAnswer =
  | { readonly by: 'hook'; readonly decision: PermissionDecision }
  | { readonly by: 'terminal'; readonly answer: TerminalAnswer };

/** The decision a `PermissionRequest` hook's reply carries, as Claude Code reads it. */
interface PermissionDecision {
  readonly behavior: 'allow' | 'deny';
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

  async function takePrompt(prompt: string): Promise<void> {
    // Written first: a conversation that took a prompt is kept, however soon the process is killed.
    transcript.recordPrompt(prompt);
    await fire({ ...recorded('UserPromptSubmit', OF_THE_SESSION), prompt });
  }

  async function turn(prompt: string, step: TurnStep): Promise<void> {
    await takePrompt(prompt);
    for (const call of step.asks ?? []) {
      if ((await ask(call)) === 'interrupted') return;
    }
    transcript.recordReply(step.reply);
    await fire({ ...recorded('Stop', STOP_WITH_NO_TASK), last_assistant_message: step.reply });
  }

  /**
   * Fires a call's hooks, the recorded payloads given its tool and input,
   * and the ids of its `PreToolUse` in those that follow, as one call's
   * hooks carry them.
   */
  function hooksOfCall(call: AskedCall) {
    const before: Record<string, unknown> = {
      ...recorded('PreToolUse', ofTheCall(call.tool)),
      tool_input: call.input,
    };
    const ids = { prompt_id: before.prompt_id, tool_use_id: before.tool_use_id };
    const ofThisCall = (event: string) => ({
      ...recorded(event, ofTheCall(call.tool)),
      tool_input: call.input,
    });
    return {
      before: () => fire(before),
      permission: () => ({ ...ofThisCall('PermissionRequest'), prompt_id: ids.prompt_id }),
      ran: () => fire({ ...ofThisCall('PostToolUse'), ...ids }),
      refused: () => fire(refusedBatch(call, ids)),
    };
  }

  function refusedBatch(call: AskedCall, ids: Record<string, unknown>): Record<string, unknown> {
    const batch = recorded('PostToolBatch', REFUSED_BATCH);
    const [refusedCall] = batch.tool_calls as Record<string, unknown>[];
    return {
      ...batch,
      prompt_id: ids.prompt_id,
      tool_calls: [
        {
          ...refusedCall,
          tool_name: call.tool,
          tool_input: call.input,
          tool_use_id: ids.tool_use_id,
        },
      ],
    };
  }

  async function ask(call: AskedCall): Promise<AskOutcome> {
    const hooksOf = hooksOfCall(call);
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
    hooksOf: ReturnType<typeof hooksOfCall>,
  ): Promise<AskOutcome> {
    if (decision.behavior === 'allow') {
      await hooksOf.ran();
      return 'went-on';
    }
    return decision.interrupt === true ? interrupted() : 'went-on';
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
        return takePrompt(parts.prompt as string);
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
