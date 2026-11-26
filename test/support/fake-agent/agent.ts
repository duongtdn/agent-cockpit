import { randomUUID } from 'node:crypto';
import type { CommandLine } from './command-line.ts';
import { type Decision, decisionOf } from './hook-answers.ts';
import {
  afterPrompt,
  type HookEvent,
  messageDisplay,
  permissionRequest,
  postToolBatch,
  postToolUse,
  preToolUse,
  type Start,
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
import { allowsEveryCallOf, deniedFolderNamedBy } from './permission-settings.ts';
import type { AgentState, Dialog, ScreenView } from './screen.ts';
import { type Step, type Turn, turnAt } from './script.ts';
import { DENIED_BY_HOOK, deniedInDontAsk, type PlannedCall, planCall } from './tool-calls.ts';
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
  /** How long ago the agent last answered in a resumed conversation; none when it never did. */
  readonly secondsSinceLastResponse: number | undefined;
  /** The folder the session runs in. */
  readonly workFolder: string;
  /** The rules the settings allow tool calls by, with no ask. */
  readonly allowRules: readonly string[];
  /** The folders the settings deny to `Read` and `Edit`: a call that names one is not played. */
  readonly deniedFolders: readonly string[];
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

/**
 * The status a fake agent exits with when it is asked to play what it has
 * no evidence for: an error of the test's, which no session of Claude Code
 * ends with.
 */
export const CANNOT_PLAY_STATUS = 70;

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

/** The status Claude Code exits with on a SIGTERM: the signal's, by the shells' convention. */
const TERMINATED_STATUS = 143;

/** The status Claude Code exits with when the person leaves. */
const LEFT_STATUS = 0;

/** Thrown inside a turn to end it as an interruption does: with no hook. */
class Interruption extends Error {}

/** A turn that runs. */
interface RunningTurn {
  /** The turn's id, which the messages shown in it carry. */
  readonly id: string;
  /** Aborted when the turn is interrupted: the hooks it waits for are let go. */
  readonly signal: AbortSignal;
  /**
   * Whether the turn produced anything yet, a tool call or a text: an Esc
   * before that withdraws the prompt instead of interrupting an answer.
   */
  produced: boolean;
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
    id: randomUUID(),
    signal: controller.signal,
    produced: false,
    toolCallOpen: false,
    interrupt: () => controller.abort(),
    during: (work) => Promise.race([work, interrupted]),
  };
}

/** How a call ended: it ran with an input, or it was refused and the model is told why. */
type CallOutcome = { readonly runsWith: ToolInput } | { readonly deniedWith: string };

/** How an ask ended: as a call does, or with a refusal that interrupts the turn. */
type AskOutcome = CallOutcome | { readonly interrupts: true };

/** The model a session names when its launch names none: the fake agent has no model. */
const UNNAMED_MODEL = 'fake-model';

/** A dialog on screen, and what a Yes in the terminal does to it. */
interface OpenDialog {
  readonly shown: Dialog;
  answerInTerminal(): void;
}

/**
 * Creates a fake agent: it plays what Claude Code does in a session, as far
 * as the hooks, the keys and the screen show it — and only what was observed
 * of Claude Code. Asked for anything else (a prompt its script has no turn
 * for, an Enter while a turn runs, a hook's answer or a tool in a mode
 * whose effect is not known, a hook that fails, a reply of several lines
 * that `MessageDisplay` hooks would be told of, a call whose suggestions or
 * whose result a hook would be told of and nothing says), it shows the
 * problem on its screen and exits
 * with {@link CANNOT_PLAY_STATUS}, with no hook: a guess would let a test
 * pass on a behavior Claude Code may not have.
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
  let step: Step | undefined;
  /** The id of the last prompt this process took: every later hook names it. */
  let promptId: string | undefined;
  let promptsTaken = surroundings.promptsTaken;
  let toolCalls = 0;
  let ending = false;

  function view(): ScreenView {
    return {
      sessionId: commandLine.sessionId,
      permissionMode: commandLine.permissionMode,
      state,
      step: step?.do,
      dialog: dialog?.shown,
      lastPrompt,
      problem,
      input: box.text(),
    };
  }

  /** Draws the screen, unless the session ends: its last screen stays, the reason of a failure on it. */
  function show(): void {
    if (!ending) surroundings.show(view());
  }

  /**
   * Tells the hooks of an event, and reads what they answered.
   *
   * @throws `Error` for an answer the fake agent does not play.
   */
  async function fire(event: HookEvent, signal?: AbortSignal): Promise<Decision> {
    const told = promptId === undefined ? event : afterPrompt(promptId, event);
    return decisionOf(event.name, await hooks.fire(told, signal));
  }

  function started(): Start {
    return commandLine.resumes
      ? { source: 'resume', secondsSinceLastResponse: surroundings.secondsSinceLastResponse }
      : { source: 'startup', model: commandLine.model ?? UNNAMED_MODEL };
  }

  async function start(): Promise<void> {
    show();
    await surroundings.startReleased();
    const reported = fire(sessionStart(started())).then(
      () => true,
      (error: unknown) => {
        fail(messageOf(error));
        return false;
      },
    );
    if (commandLine.prompt === undefined) {
      // Whoever learns of SessionStart may type at once: no key may be lost from here on.
      state = 'idle';
      show();
    } else if (await reported) {
      submit(commandLine.prompt);
    }
  }

  function press(key: Key): void {
    if (ending) return;
    box.press(key);
    if (key.kind === 'enter') pressEnter();
    if (key.kind === 'escape') turn?.interrupt();
    show();
  }

  /**
   * Enter answers a dialog, or submits the input box of an idle session. A
   * session that starts loses it. What Claude Code does with one while a
   * turn runs was not observed.
   */
  function pressEnter(): void {
    if (dialog) dialog.answerInTerminal();
    else if (state === 'busy')
      fail('Enter was pressed while a turn runs: nothing tells what Claude Code does with it');
    else if (state === 'idle' && box.text() !== '') submit(box.take());
  }

  /** Ends the process as a program that cannot go on does, unless it ends already. */
  function fail(reason: string): void {
    if (ending) return;
    ending = true;
    quit(reason);
  }

  /** Exits with the reason on the screen, which stays. */
  function quit(reason: string): void {
    problem = reason;
    surroundings.show(view());
    surroundings.exit(CANNOT_PLAY_STATUS);
  }

  function submit(prompt: string): void {
    const running = startTurn();
    const promptBefore = lastPrompt;
    turn = running;
    lastPrompt = prompt;
    state = 'busy';
    show();
    void playTurn(prompt, running, () => withdraw(prompt, promptBefore));
  }

  /**
   * Takes a prompt back as Claude Code does on an Esc before anything was
   * produced: into the input box, with no word to the hooks or the
   * transcript. The entry the prompt got when it was taken stays, as Claude
   * Code leaves it, and so does its place in the script.
   */
  function withdraw(prompt: string, promptBefore: string | undefined): void {
    box.putBack(prompt);
    lastPrompt = promptBefore;
  }

  async function playTurn(
    prompt: string,
    running: RunningTurn,
    withdrawPrompt: () => void,
  ): Promise<void> {
    try {
      transcript.recordPrompt(prompt);
      promptId = randomUUID();
      const place = promptsTaken;
      promptsTaken += 1;
      const steps = turnAt(surroundings.readScript(), place);
      await running.during(fire(userPromptSubmit(prompt), running.signal));
      for (const next of steps) await play(next, running);
    } catch (error) {
      if (!(error instanceof Interruption)) {
        fail(messageOf(error));
        return;
      }
      // What Esc did not abort, a deny that interrupts did not either: let go of every hook.
      running.interrupt();
      // Seen of Claude Code: a prompt is withdrawn only into an empty input box.
      if (running.produced || box.text() !== '') recordInterruption(running);
      else withdrawPrompt();
    }
    dialog = undefined;
    turn = undefined;
    step = undefined;
    state = 'idle';
    show();
  }

  function recordInterruption(running: RunningTurn): void {
    transcript.recordInterruption(running.toolCallOpen ? INTERRUPTED_FOR_TOOL_USE : INTERRUPTED);
  }

  function play(next: Step, running: RunningTurn): Promise<unknown> {
    step = next;
    show();
    switch (next.do) {
      case 'reply':
        return playReply(next.text, running);
      case 'tool':
      case 'question':
        return playCall(planCall(next), running);
      case 'stay-busy':
        return running.during(new Promise(() => {}));
      case 'exit':
        return end('prompt_input_exit', LEFT_STATUS);
    }
  }

  function playReply(text: string, running: RunningTurn): Promise<unknown> {
    running.produced = true;
    displayMessage(text, running);
    transcript.recordReply(text);
    return running.during(fire(stop(text), running.signal));
  }

  /**
   * Tells the `MessageDisplay` hooks, when the settings have any, of a reply.
   * Seen of Claude Code: the turn does not wait for their answer, and `Stop`
   * follows while they are still open.
   *
   * @throws `Error` for a reply of several lines, which Claude Code tells in
   * parts cut in a way that was not made out.
   */
  function displayMessage(text: string, running: RunningTurn): void {
    if (!hooks.configures('MessageDisplay')) return;
    if (text.includes('\n')) {
      throw new Error(
        'the settings have a MessageDisplay hook, and the script a reply of several lines: nothing tells how Claude Code parts it',
      );
    }
    const shown = messageDisplay({ turnId: running.id, messageId: randomUUID(), text });
    fire(shown, running.signal).catch((error: unknown) => fail(messageOf(error)));
  }

  /**
   * Plays a call of the script.
   *
   * @throws `Error` for a call that names a folder the settings deny.
   */
  async function playCall(planned: PlannedCall, running: RunningTurn): Promise<void> {
    const denied = deniedFolderNamedBy(planned.input, surroundings.deniedFolders);
    if (denied !== undefined) {
      throw new Error(
        `the script calls ${planned.name} on ${denied}, which the settings deny: nothing tells what Claude Code answers there`,
      );
    }
    toolCalls += 1;
    const call = { id: `toolu_fake_${toolCalls}`, name: planned.name, input: planned.input };
    running.produced = true;
    running.toolCallOpen = true;
    transcript.recordToolCall(call);
    const before = await running.during(fire(preToolUse(call), running.signal));
    const settled = inputSettledBy(before, planned);
    const outcome =
      settled === undefined ? await outcomeByMode(planned, call, running) : { runsWith: settled };
    if ('runsWith' in outcome) {
      const ran = postToolUse(
        { ...call, input: outcome.runsWith },
        planned.responseTo(outcome.runsWith),
      );
      await running.during(fire(ran, running.signal));
    }
    await tellOfTheBatch(planned, call, outcome, running);
    running.toolCallOpen = false;
  }

  /**
   * Tells the `PostToolBatch` hooks, when the settings have any, that the
   * call is over and what the model is told of it. Seen of Claude Code: a
   * refused call is told of too, and the turn goes on after their answer.
   *
   * @throws `Error` for a call that ran and whose script gives no result.
   */
  async function tellOfTheBatch(
    planned: PlannedCall,
    call: ToolCall,
    outcome: CallOutcome,
    running: RunningTurn,
  ): Promise<void> {
    if (!hooks.configures('PostToolBatch')) return;
    const result = 'runsWith' in outcome ? planned.resultOf(outcome.runsWith) : outcome.deniedWith;
    await running.during(fire(postToolBatch(call, result), running.signal));
  }

  /**
   * Gives how a call ends in the session's mode, when no `PreToolUse` hook settled it.
   *
   * @throws `Interruption` for an ask that a refusal ends along with the turn.
   */
  async function outcomeByMode(
    planned: PlannedCall,
    call: ToolCall,
    running: RunningTurn,
  ): Promise<CallOutcome> {
    const isAllowed = allowsEveryCallOf(surroundings.allowRules, planned.name);
    const route = planned.routeIn(commandLine.permissionMode, isAllowed);
    if (route === 'run') return { runsWith: planned.input };
    if (route === 'deny') return { deniedWith: deniedInDontAsk(planned.name) };
    const outcome = await ask(planned, call, running);
    if ('interrupts' in outcome) throw new Interruption();
    return outcome;
  }

  /**
   * Asks about a call in the terminal and through `PermissionRequest` at
   * once: the first answer wins, and a hook without a decision leaves the
   * dialog to the terminal.
   *
   * @throws `Error` for a call whose suggestions a hook would be told of and nothing says.
   */
  async function ask(
    planned: PlannedCall,
    call: ToolCall,
    running: RunningTurn,
  ): Promise<AskOutcome> {
    const asked = hooks.configures('PermissionRequest')
      ? permissionRequest(call, planned.suggestionsIn(surroundings.workFolder))
      : permissionRequest(call);
    const fromTerminal = new Promise<AskOutcome>((resolve) => {
      dialog = {
        shown: { kind: planned.dialog, toolName: planned.name },
        answerInTerminal: () => resolve({ runsWith: planned.inputFromTerminal() }),
      };
    });
    state = 'waiting';
    show();
    const fromHooks = fire(asked, running.signal).then(
      (decision) => outcomeOf(decision, planned) ?? fromTerminal,
    );
    // The hook stays open after an answer in the terminal: what it answers then is still read.
    fromHooks.catch((error: unknown) => fail(messageOf(error)));
    const outcome = await running.during(Promise.race([fromTerminal, fromHooks]));
    dialog = undefined;
    state = 'busy';
    show();
    return outcome;
  }

  async function end(reason: 'prompt_input_exit' | 'other', status: number): Promise<void> {
    if (ending) return;
    ending = true;
    try {
      await fire(sessionEnd(reason));
    } catch (error) {
      quit(messageOf(error));
      return;
    }
    surroundings.exit(status);
  }

  return { start, press, terminate: () => end('other', TERMINATED_STATUS) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Gives the input an allow lets a call run with, or none when the decision does not settle the call. */
function inputSettledBy(decision: Decision, planned: PlannedCall): ToolInput | undefined {
  if (decision.behavior !== 'allow') return undefined;
  const input = decision.updatedInput ?? planned.input;
  return planned.isSettledBy(input) ? input : undefined;
}

/** Reads how a hook's decision ends an ask, or nothing when it leaves the ask open. */
function outcomeOf(decision: Decision, planned: PlannedCall): AskOutcome | undefined {
  if (decision.behavior === 'deny') {
    return decision.interrupts
      ? { interrupts: true }
      : { deniedWith: decision.message ?? DENIED_BY_HOOK };
  }
  const input = inputSettledBy(decision, planned);
  return input === undefined ? undefined : { runsWith: input };
}
