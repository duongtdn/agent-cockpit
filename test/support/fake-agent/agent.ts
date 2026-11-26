import type { CommandLine } from './command-line.ts';
import { type Decision, decisionOf } from './hook-decisions.ts';
import {
  permissionRequest,
  postToolUse,
  preToolUse,
  sessionEnd,
  sessionStart,
  stop,
  type ToolCall,
  type ToolInput,
  userPromptSubmit,
} from './hook-events.ts';
import type { HookRunner } from './hook-runner.ts';
import { createInputBox } from './input-box.ts';
import type { Key } from './keys.ts';
import type { AgentState, Dialog, ScreenView } from './screen.ts';
import { type Step, type Turn, turnAt } from './script.ts';
import { type PlannedCall, planCall } from './tool-calls.ts';
import { INTERRUPTED, INTERRUPTED_FOR_TOOL_USE, type Transcript } from './transcript.ts';

/** What a fake agent is given by the process it runs in. */
export interface AgentSurroundings {
  /** The command line it was launched with. */
  readonly commandLine: CommandLine;
  /** The hooks of its settings. */
  readonly hooks: HookRunner;
  /** Where its conversation is written. */
  readonly transcript: Transcript;
  /** How many prompts the conversation took before this process: where a resumed one goes on in the script. */
  readonly promptsTaken: number;
  /** Waits until the test lets the session get ready; at once when nothing holds it. */
  startReleased(): Promise<void>;
  /**
   * Reads the script as it is now.
   *
   * @throws For a script that cannot be played.
   */
  readScript(): readonly Turn[];
  /** Draws the screen. */
  show(view: ScreenView): void;
  /** Ends the process with a status. */
  exit(status: number): void;
}

/** The agent's side of a session: it reports through hooks and takes keys. */
export interface FakeAgent {
  /**
   * Starts the session: fires `SessionStart`, and from then on takes typed
   * prompts. A prompt of the command line is submitted instead, once the
   * hooks of `SessionStart` have answered, so that the two events keep
   * their order.
   *
   * @returns A promise fulfilled once the session takes input or runs its first turn.
   */
  start(): Promise<void>;
  /** Takes a key from the terminal. */
  press(key: Key): void;
  /**
   * Ends the session as a SIGTERM does: fires `SessionEnd` with the reason
   * `other`, then exits.
   */
  terminate(): Promise<void>;
}

/** The exit status of a process ended by SIGTERM, by the shells' convention. */
const TERMINATED_STATUS = 143;

/** Thrown inside a turn to end it as an interruption does: with no hook. */
class Interruption extends Error {}

/** A turn that runs. */
interface RunningTurn {
  /** Aborted when the turn is interrupted: the hooks it waits for are let go. */
  readonly signal: AbortSignal;
  /** Whether a tool call is open, which names the interruption in the transcript. */
  toolCallOpen: boolean;
  interrupt(): void;
  /** Waits for some work of the turn; rejects with an `Interruption` when the turn is interrupted first. */
  during<T>(work: Promise<T>): Promise<T>;
}

function startTurn(): RunningTurn {
  const controller = new AbortController();
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Interruption()), { once: true });
  });
  // An interruption nobody waits for, between two steps, is still handled by the next wait.
  interrupted.catch(() => {});
  return {
    signal: controller.signal,
    toolCallOpen: false,
    interrupt: () => controller.abort(),
    during: (work) => Promise.race([work, interrupted]),
  };
}

/** How an ask ended: the call runs with an input, or it does not run. */
type AskOutcome =
  | { readonly runsWith: ToolInput }
  | { readonly runsWith: undefined; readonly interrupts: boolean };

/** A dialog on screen, and what a Yes in the terminal does to it. */
interface OpenDialog {
  readonly shown: Dialog;
  answerInTerminal(): void;
}

/**
 * Creates a fake agent: it plays what Claude Code does in a session, as far
 * as the hooks, the keys and the screen show it.
 *
 * @param surroundings - Its command line, its hooks, its transcript, its script and its terminal.
 * @returns The agent, not yet started.
 */
export function createFakeAgent(surroundings: AgentSurroundings): FakeAgent {
  const { commandLine, hooks, transcript } = surroundings;
  const box = createInputBox();
  let state: AgentState = 'starting';
  let dialog: OpenDialog | undefined;
  let lastPrompt: string | undefined;
  let problem: string | undefined;
  let turn: RunningTurn | undefined;
  let promptsTaken = surroundings.promptsTaken;
  let toolCalls = 0;
  let ending = false;

  function show(): void {
    surroundings.show({
      sessionId: commandLine.sessionId,
      permissionMode: commandLine.permissionMode,
      state,
      dialog: dialog?.shown,
      lastPrompt,
      problem,
      input: box.text(),
    });
  }

  async function start(): Promise<void> {
    show();
    await surroundings.startReleased();
    const reported = hooks.fire(sessionStart(commandLine.resumes ? 'resume' : 'startup'));
    if (commandLine.prompt === undefined) {
      // Whoever learns of SessionStart may type at once: no key may be lost from here on.
      state = 'idle';
      show();
    } else {
      await reported;
      submit(commandLine.prompt);
    }
  }

  function press(key: Key): void {
    box.press(key);
    if (key.kind === 'enter') pressEnter();
    if (key.kind === 'escape') turn?.interrupt();
    show();
  }

  /** Enter answers a dialog, or submits the input box of an idle session; at any other time it is lost. */
  function pressEnter(): void {
    if (dialog) dialog.answerInTerminal();
    else if (state === 'idle' && box.text() !== '') submit(box.take());
  }

  function submit(prompt: string): void {
    const running = startTurn();
    turn = running;
    lastPrompt = prompt;
    problem = undefined;
    state = 'busy';
    show();
    void playTurn(prompt, running);
  }

  async function playTurn(prompt: string, running: RunningTurn): Promise<void> {
    try {
      transcript.recordPrompt(prompt);
      const place = promptsTaken;
      promptsTaken += 1;
      const steps = turnAt(surroundings.readScript(), place);
      await running.during(hooks.fire(userPromptSubmit(prompt), running.signal));
      for (const step of steps) await play(step, running);
    } catch (error) {
      if (error instanceof Interruption) recordInterruption(running);
      else problem = error instanceof Error ? error.message : String(error);
    }
    dialog = undefined;
    turn = undefined;
    state = 'idle';
    show();
  }

  function recordInterruption(running: RunningTurn): void {
    // What Esc did not abort, a deny that interrupts did not either: let go of every hook.
    running.interrupt();
    transcript.recordInterruption(running.toolCallOpen ? INTERRUPTED_FOR_TOOL_USE : INTERRUPTED);
  }

  function play(step: Step, running: RunningTurn): Promise<unknown> {
    switch (step.do) {
      case 'reply':
        transcript.recordReply(step.text);
        return running.during(hooks.fire(stop(step.text), running.signal));
      case 'tool':
      case 'question':
        return playCall(planCall(step), running);
      case 'stay-busy':
        return running.during(new Promise(() => {}));
      case 'exit':
        return end('prompt_input_exit', 0);
    }
  }

  async function playCall(planned: PlannedCall, running: RunningTurn): Promise<void> {
    toolCalls += 1;
    const call = { id: `toolu_fake_${toolCalls}`, name: planned.name, input: planned.input };
    running.toolCallOpen = true;
    const before = await running.during(hooks.fire(preToolUse(call), running.signal));
    const input =
      inputSettledBy(decisionOf(before), planned) ?? (await inputByMode(planned, call, running));
    if (input !== undefined) {
      const ran = postToolUse({ ...call, input }, planned.responseTo(input));
      await running.during(hooks.fire(ran, running.signal));
    }
    running.toolCallOpen = false;
  }

  /** Gives the input a call runs with in the session's mode, or none when it does not run. */
  async function inputByMode(
    planned: PlannedCall,
    call: ToolCall,
    running: RunningTurn,
  ): Promise<ToolInput | undefined> {
    const route = planned.routeIn(commandLine.permissionMode);
    if (route === 'run') return planned.input;
    if (route === 'deny') return undefined;
    const outcome = await ask(planned, call, running);
    if (outcome.runsWith === undefined && outcome.interrupts) throw new Interruption();
    return outcome.runsWith;
  }

  /**
   * Asks about a call in the terminal and through `PermissionRequest` at
   * once: the first answer wins, and a hook without a decision leaves the
   * dialog to the terminal.
   */
  async function ask(
    planned: PlannedCall,
    call: ToolCall,
    running: RunningTurn,
  ): Promise<AskOutcome> {
    const fromTerminal = new Promise<AskOutcome>((resolve) => {
      dialog = {
        shown: { kind: planned.dialog, toolName: planned.name },
        answerInTerminal: () => resolve({ runsWith: planned.inputFromTerminal() }),
      };
    });
    state = 'waiting';
    show();
    const fromHooks = hooks
      .fire(permissionRequest(call), running.signal)
      .then((outputs) => outcomeOf(decisionOf(outputs), planned) ?? fromTerminal);
    const outcome = await running.during(Promise.race([fromTerminal, fromHooks]));
    dialog = undefined;
    state = 'busy';
    show();
    return outcome;
  }

  async function end(reason: 'prompt_input_exit' | 'other', status: number): Promise<void> {
    if (ending) return;
    ending = true;
    await hooks.fire(sessionEnd(reason));
    surroundings.exit(status);
  }

  return { start, press, terminate: () => end('other', TERMINATED_STATUS) };
}

/** Gives the input an allow lets a call run with, or none when the decision does not settle the call. */
function inputSettledBy(decision: Decision, planned: PlannedCall): ToolInput | undefined {
  if (decision.behavior !== 'allow') return undefined;
  const input = decision.updatedInput ?? planned.input;
  return planned.isSettledBy(input) ? input : undefined;
}

/** Reads how a hook's decision ends an ask, or nothing when it leaves the ask open. */
function outcomeOf(decision: Decision, planned: PlannedCall): AskOutcome | undefined {
  if (decision.behavior === 'deny') return { runsWith: undefined, interrupts: decision.interrupts };
  const input = inputSettledBy(decision, planned);
  return input === undefined ? undefined : { runsWith: input };
}
