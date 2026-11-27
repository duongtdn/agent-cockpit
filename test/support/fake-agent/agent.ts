import type { ShapeChoice } from '../recorded-hooks.ts';
import type { HookRunner } from './hook-runner.ts';
import type { Step } from './script.ts';
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

  async function turn(prompt: string, reply: string): Promise<void> {
    await takePrompt(prompt);
    transcript.recordReply(reply);
    await fire({ ...recorded('Stop', STOP_WITH_NO_TASK), last_assistant_message: reply });
  }

  async function play(step: Step): Promise<void> {
    switch (step.do) {
      case 'turn':
        return turn(parts.prompt as string, step.reply);
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
