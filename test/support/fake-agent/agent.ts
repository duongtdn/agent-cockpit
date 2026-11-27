import { randomUUID } from 'node:crypto';
import type { TerminalSize } from './box-layout.ts';
import type { CommandLine } from './command-line.ts';
import type { AgentConfiguration, StartUpDialogKind } from './configuration.ts';
import { type Decision, decisionOf } from './hook-answers.ts';
import {
  afterPrompt,
  type BackgroundTask,
  bySubagent,
  compactionFailure,
  type HookEvent,
  messageDisplay,
  permissionRequest,
  postCompact,
  postToolBatch,
  postToolUse,
  preCompact,
  preToolUse,
  type Start,
  type Subagent,
  sessionEnd,
  sessionStart,
  stop,
  stopFailure,
  subagentStart,
  subagentStop,
  type ToolCall,
  type ToolInput,
  userPromptSubmit,
} from './hook-events.ts';
import type { HookRunner } from './hook-runner.ts';
import { createInputBox, type DrawnBox } from './input-box.ts';
import type { Key } from './keys.ts';
import { allowsEveryCallOf, deniedPathNamedBy } from './permission-settings.ts';
import type { AgentState, Dialog, ScreenView, ShownStartUpDialog } from './screen.ts';
import {
  COMPACTIONS,
  type Compaction,
  type Step,
  type TaskStep,
  type ToolStep,
  type Turn,
  turnAt,
} from './script.ts';
import {
  type DialogSubjects,
  START_UP_DIALOGS,
  type StartUpAnswer,
  UNTRUSTED_EXIT_LINES,
} from './start-up-dialogs.ts';
import {
  drawAgentId,
  type LaunchedTask,
  launchedTaskResponse,
  launchedTaskResult,
  type TaskFiles,
  taskNotification,
} from './tasks.ts';
import { DENIED_BY_HOOK, deniedInDontAsk, type PlannedCall, planCall } from './tool-calls.ts';
import { INTERRUPTED, INTERRUPTED_FOR_TOOL_USE, type Transcript } from './transcript.ts';
import { type Failure, failureOf, NOT_LOGGED_IN } from './turn-failures.ts';

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
  /**
   * Whether the prompts Up would show are all this process's own to know:
   * no conversation of the folder's project took any before it. Claude Code
   * shows earlier sessions' too, in a way that was not made out.
   */
  readonly historyIsOwn: boolean;
  /** The terminal's size now, which the input box is laid out in. */
  terminalSize(): TerminalSize;
  /** The rules the settings allow tool calls by, with no ask. */
  readonly allowRules: readonly string[];
  /**
   * The paths the settings deny: folders to `Read` and `Edit`, files to
   * `Edit`, each absolute or the end of one. A call that names one is not
   * played.
   */
  readonly deniedPaths: readonly string[];
  /** What the agent's configuration shows at the start, and where the answers go. */
  readonly configuration: Pick<
    AgentConfiguration,
    'startUpDialogs' | 'keyRejected' | 'accept' | 'rejectKey'
  >;
  /** What the start-up dialogs name: the folder, the key. */
  readonly dialogSubjects: DialogSubjects;
  /** The API's address (`ANTHROPIC_BASE_URL`), which some failures name; none when it is not set. */
  readonly apiBaseUrl: string | undefined;
  /** Gives the files Claude Code keeps for a background task. */
  taskFiles(agentId: string): TaskFiles;
  /** Waits until the test lets the session get ready; at once when nothing holds it. */
  startReleased(): Promise<void>;
  /** Waits until the test lets background tasks work; at once when nothing holds them. */
  tasksReleased(): Promise<void>;
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

/**
 * The status the fake agent exits with when the person declines a start-up
 * dialog. Claude Code's was not observed, and nothing here reads it: the
 * session is gone, which is what tells.
 */
const DECLINED_STATUS = 1;

/** The only local command the fake agent plays: the others were not observed, or not as typed. */
const COMPACT_COMMAND = '/compact';

/** What Claude Code draws after `/compact` put back into the input box: its argument's hint. */
const COMPACT_ARGUMENT_HINT = '<optional custom summarization instructions>';

/** The first words of what Claude Code records as the output of a compaction done. */
const COMPACTED = 'Compacted (ctrl+o to see full summary)';

/**
 * How long after `PermissionRequest` is sent the permission dialog is
 * drawn: Claude Code was seen to draw it 324 to 514 ms after the hook
 * reached its receiver, the input box on screen and taking keys until then.
 * Not played: keys typed into the box meanwhile put it off until about
 * 1.5 s after the last of them, and on a loaded machine it took keys as a
 * dialog's a few ms after the hook arrived, so no test may count on the gap.
 */
const PERMISSION_DIALOG_DELAY_MS = 400;

/** What the screen shows of an input box it cannot draw, once the agent fails on it. */
const UNDRAWN_BOX: DrawnBox = {
  rows: [],
  above: undefined,
  below: undefined,
  looksEmpty: true,
  inShellMode: false,
  cursor: { row: 0, column: 0 },
};

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

/** A start-up dialog on screen, and its option selected now. */
interface OpenStartUpDialog {
  readonly kind: StartUpDialogKind;
  selected: number;
  answer(answer: StartUpAnswer): void;
}

/** A subagent running in the background, from its `Agent` call to its end. */
interface PendingTask {
  readonly agent: Subagent;
  readonly step: TaskStep;
  readonly launched: LaunchedTask;
  readonly toolUseId: string;
  readonly startedAt: number;
  /** Whether it does its work now: it begins once the turn that started it ended. */
  working: boolean;
}

/**
 * Creates a fake agent: it plays what Claude Code does in a session, as far
 * as the hooks, the keys and the screen show it — the start-up dialogs its
 * configuration shows, turns, asks, failed turns, a task in the background,
 * `/compact` — and only what was observed of Claude Code. Asked for anything else (a prompt its script has no turn
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
  /** The prompts this process took, for Up to show; `undefined` once what Claude Code would show is not known. */
  let history: string[] | undefined = surroundings.historyIsOwn ? [] : undefined;
  const box = createInputBox({ size: surroundings.terminalSize, history: () => history });
  let state: AgentState = 'starting';
  let startUpDialog: OpenStartUpDialog | undefined;
  let farewell: readonly string[] | undefined;
  let keyRejected = surroundings.configuration.keyRejected;
  let task: PendingTask | undefined;
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
  let subagentEnded = false;
  let compacting = false;
  /** Ends a compaction that stays until the person's Esc; none while no such compaction runs. */
  let interruptCompaction: (() => void) | undefined;
  /** Whether the input box holds the command an interruption put back, drawn with its hint. */
  let commandPutBack = false;

  function view(drawnBox: DrawnBox = withHint(box.drawn())): ScreenView {
    return {
      sessionId: commandLine.sessionId,
      permissionMode: commandLine.permissionMode,
      state,
      step: step?.do,
      dialog: dialog?.shown,
      lastPrompt,
      problem,
      box: drawnBox,
      subagentEnded,
      compacting,
      startUpDialog: shownStartUpDialog(),
      farewell,
    };
  }

  /** The box as drawn, with the hint of a command put back after its first row. */
  function withHint(drawnBox: DrawnBox): DrawnBox {
    if (!commandPutBack) return drawnBox;
    const [first = '', ...others] = drawnBox.rows;
    return { ...drawnBox, rows: [`${first}  ${COMPACT_ARGUMENT_HINT}`, ...others] };
  }

  function shownStartUpDialog(): ShownStartUpDialog | undefined {
    if (startUpDialog === undefined) return undefined;
    const { kind, selected } = startUpDialog;
    return { kind, selected, subjects: surroundings.dialogSubjects };
  }

  /** Draws the screen, unless the session ends: its last screen stays, the reason of a failure on it. */
  function show(): void {
    if (ending) return;
    try {
      surroundings.show(view());
    } catch (error) {
      fail(messageOf(error));
    }
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
    for (const kind of surroundings.configuration.startUpDialogs) {
      if (!(await passStartUpDialog(kind))) return;
    }
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
      submitLaunchPrompt(commandLine.prompt);
    }
  }

  /**
   * Shows a start-up dialog and plays the person's answer, as Claude Code
   * does before any hook.
   *
   * @returns Whether the session goes on.
   */
  async function passStartUpDialog(kind: StartUpDialogKind): Promise<boolean> {
    const answer = await new Promise<StartUpAnswer>((resolve) => {
      startUpDialog = { kind, selected: START_UP_DIALOGS[kind].selected, answer: resolve };
      show();
    });
    if (answer === 'decline-and-exit') {
      await decline(kind);
      return false;
    }
    // Seen of Claude Code: an answered dialog leaves the screen at once, well before SessionStart.
    startUpDialog = undefined;
    show();
    if (answer === 'accept') surroundings.configuration.accept(kind);
    else {
      surroundings.configuration.rejectKey();
      keyRejected = true;
    }
    return true;
  }

  /**
   * Leaves at a start-up dialog, which stays on the last screen. Seen of
   * Claude Code: declining the trust fires no hook, and says why below the
   * dialog; declining the warning of `bypassPermissions` fires `SessionEnd`.
   */
  async function decline(kind: StartUpDialogKind): Promise<void> {
    if (kind === 'bypass-permissions') {
      await end('other', DECLINED_STATUS);
      return;
    }
    farewell = UNTRUSTED_EXIT_LINES;
    show();
    ending = true;
    surroundings.exit(DECLINED_STATUS);
  }

  /**
   * Plays a key on a start-up dialog: Up and Down move the selection, Enter
   * chooses, Esc does what it was seen to do. What else a key does there,
   * or Up on the first option and Down on the last, was not observed.
   */
  function pressOnStartUpDialog(open: OpenStartUpDialog, key: Key): void {
    const { options, escape: onEscape } = START_UP_DIALOGS[open.kind];
    const move = key.kind === 'up' ? -1 : key.kind === 'down' ? 1 : 0;
    if (move !== 0 && options[open.selected + move] !== undefined) {
      open.selected += move;
      show();
    } else if (key.kind === 'enter') {
      open.answer((options[open.selected] as (typeof options)[number]).answer);
    } else if (key.kind === 'escape' && onEscape !== undefined) {
      open.answer(onEscape);
    } else {
      fail(
        `the key ${key.kind} on the ${open.kind} dialog: what Claude Code does with it was not observed`,
      );
    }
  }

  function press(key: Key): void {
    if (ending) return;
    if (startUpDialog !== undefined) {
      pressOnStartUpDialog(startUpDialog, key);
      return;
    }
    if (dialog !== undefined) {
      pressOnDialog(dialog, key);
      return;
    }
    if (commandPutBack) {
      pressOnCommandPutBack(key);
      return;
    }
    if (key.kind === 'escape' && interruptCompaction !== undefined) {
      pressEscapeOnCompaction(interruptCompaction);
      return;
    }
    try {
      pressInBox(key);
    } catch (error) {
      fail(messageOf(error));
      return;
    }
    if (key.kind === 'enter') pressEnter();
    if (key.kind === 'escape') turn?.interrupt();
    show();
  }

  /**
   * Plays a key on the command an interrupted compaction put back. Seen of
   * Claude Code: Ctrl+U clears the box, hint and all. What any other key
   * does there was not observed.
   */
  function pressOnCommandPutBack(key: Key): void {
    if (key.kind !== 'kill-line') {
      fail(
        `the key ${key.kind} on ${COMPACT_COMMAND} put back after an interrupted compaction: what Claude Code does with it was not observed`,
      );
      return;
    }
    commandPutBack = false;
    pressInBox(key);
    show();
  }

  /** Interrupts a compaction on Esc, as seen of Claude Code over an empty input box only. */
  function pressEscapeOnCompaction(interrupt: () => void): void {
    if (box.text() !== '') {
      fail('Esc over a draft while a compaction runs: what Claude Code does then was not observed');
      return;
    }
    interrupt();
  }

  /**
   * Gives a key to the input box. Seen of Claude Code: Down that leaves the
   * box while a background task runs moves to the task in the footer, and
   * the keys after it go to the task's panel; that is not played.
   */
  function pressInBox(key: Key): void {
    if (key.kind === 'down' && task !== undefined && box.downLeavesTheBox()) {
      throw new Error(
        'Down past the input box while a background task runs: Claude Code moves to the task in its footer, which the fake agent does not play',
      );
    }
    box.press(key);
  }

  /**
   * Plays a key on a dialog over the input box. Seen of Claude Code: Enter
   * answers it with the option selected (Yes), Esc interrupts the turn, and
   * text typed on a permission dialog does nothing. Any other key (a digit
   * alone, which may choose an option; Down, which moves the selection) was
   * not observed as the fake agent would play it.
   */
  function pressOnDialog(open: OpenDialog, key: Key): void {
    if (key.kind === 'enter') open.answerInTerminal();
    else if (key.kind === 'escape') turn?.interrupt();
    else if (!isIgnoredOn(open.shown, key)) {
      fail(
        `the key ${key.kind} on a ${open.shown.kind} dialog: what Claude Code does with it was not observed`,
      );
    }
  }

  /**
   * Enter submits the input box of an idle session. A session that starts
   * loses it. What Claude Code does with one while a turn runs was not
   * observed, nor what it runs in shell mode.
   */
  function pressEnter(): void {
    if (state === 'busy')
      fail('Enter was pressed while a turn runs: nothing tells what Claude Code does with it');
    else if (state === 'idle' && box.text() !== '') submitInputBox();
  }

  function submitInputBox(): void {
    if (box.inShellMode()) {
      fail(
        'Enter in shell mode: Claude Code runs the text as a shell command, which the fake agent does not play',
      );
      return;
    }
    try {
      const prompt = promptOf(box.take());
      if (prompt === '') throw new Error('Enter on an input box of blanks: not observed');
      submit(prompt);
    } catch (error) {
      fail(messageOf(error));
    }
  }

  /** A prompt of the command line is taken as it is: whether Claude Code trims one there was not observed. */
  function submitLaunchPrompt(prompt: string): void {
    try {
      if (promptOf(prompt) !== prompt) {
        throw new Error(
          'a launch prompt with blanks at its end or an invisible separator: what Claude Code makes of it on the command line was not observed',
        );
      }
      submit(prompt);
    } catch (error) {
      fail(messageOf(error));
    }
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
    // A start-up dialog would cover the reason.
    startUpDialog = undefined;
    surroundings.show(view(drawnOrNone()));
    surroundings.exit(CANNOT_PLAY_STATUS);
  }

  /** The input box as drawn; none, when it is what the agent cannot draw. */
  function drawnOrNone(): DrawnBox {
    try {
      return box.drawn();
    } catch {
      return UNDRAWN_BOX;
    }
  }

  /**
   * Takes what the input box submitted: a prompt, or `/compact`. Any other
   * local command, and a prompt while a background task is pending (whose
   * end starts a turn by itself), were not observed of a typed prompt here.
   */
  function submit(prompt: string): void {
    if (prompt.startsWith('/')) {
      // Whether Claude Code keeps a command in the history of the prompts was not observed.
      history = undefined;
      if (prompt === COMPACT_COMMAND) void compact();
      else fail(`the local command ${JSON.stringify(prompt)}: only ${COMPACT_COMMAND} is played`);
      return;
    }
    if (task !== undefined) {
      fail('a prompt while a background task is pending: the fake agent plays its end first');
      return;
    }
    history?.push(prompt);
    startTurnOn(prompt);
  }

  function startTurnOn(prompt: string): void {
    const running = startTurn();
    const promptBefore = lastPrompt;
    turn = running;
    lastPrompt = prompt;
    state = 'busy';
    show();
    void playTurn(prompt, running, () => withdraw(prompt, promptBefore)).then(startPendingTask);
  }

  /**
   * Takes a prompt back as Claude Code does on an Esc before anything was
   * produced: into the input box, with no word to the hooks or the
   * transcript. The entry the prompt got when it was taken stays, as Claude
   * Code leaves it, and so does its place in the script.
   */
  function withdraw(prompt: string, promptBefore: string | undefined): void {
    // Whether the history keeps a withdrawn prompt was not observed.
    history = undefined;
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
      if (keyRejected) {
        await running.during(fire(userPromptSubmit(prompt), running.signal));
        await failTurn(NOT_LOGGED_IN, running);
      } else {
        const place = promptsTaken;
        promptsTaken += 1;
        const steps = turnAt(surroundings.readScript(), place);
        await running.during(fire(userPromptSubmit(prompt), running.signal));
        for (const next of steps) await play(next, running);
      }
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
      case 'fail':
        return failTurn(failureOf(next.status, surroundings.apiBaseUrl), running);
      case 'task':
        return launchTask(next, running);
      case 'compact':
      case 'compact-fails':
      case 'compact-stays':
        throw new Error(`a prompt meets the script's compaction: only ${COMPACT_COMMAND} plays it`);
    }
  }

  function playReply(text: string, running: RunningTurn): Promise<unknown> {
    running.produced = true;
    displayMessage(text, running);
    transcript.recordReply(text);
    return running.during(fire(stop(text, backgroundTasks()), running.signal));
  }

  /** Ends a turn on an error, as Claude Code does once its retries are spent: `StopFailure`, never `Stop`. */
  function failTurn(failure: Failure, running: RunningTurn): Promise<unknown> {
    running.produced = true;
    transcript.recordApiError(failure);
    return running.during(fire(stopFailure(failure.error, failure.message), running.signal));
  }

  /** The tasks `Stop` lists: the subagent running in the background, if any. */
  function backgroundTasks(): BackgroundTask[] {
    if (task === undefined) return [];
    const { agent, step } = task;
    return [
      {
        id: agent.id,
        type: 'subagent',
        status: 'running',
        description: step.description,
        agent_type: agent.type,
      },
    ];
  }

  /**
   * Starts a subagent in the background, as Claude Code does with every
   * `Agent` call (seen with `run_in_background` false too): `PreToolUse`,
   * `SubagentStart`, then the call's answer at once.
   *
   * @throws `Error` for a second task while one is pending, in a mode other
   * than `default`, and for a `PreToolUse` hook that decides: none was observed.
   */
  async function launchTask(step: TaskStep, running: RunningTurn): Promise<void> {
    if (task !== undefined)
      throw new Error('a second background task: the fake agent plays one at a time');
    if (commandLine.permissionMode !== 'default') {
      throw new Error(
        `a background task in the ${commandLine.permissionMode} mode: only default was observed`,
      );
    }
    toolCalls += 1;
    const input = {
      description: step.description,
      prompt: step.prompt,
      subagent_type: step.agentType,
    };
    const call = { id: `toolu_fake_${toolCalls}`, name: 'Agent', input };
    running.produced = true;
    running.toolCallOpen = true;
    transcript.recordToolCall(call);
    const before = await running.during(fire(preToolUse(call), running.signal));
    if (before.behavior !== 'none')
      throw new Error('a PreToolUse hook decides on an Agent call: not observed');
    const agent = { id: drawAgentId(), type: step.agentType };
    const launched: LaunchedTask = {
      agentId: agent.id,
      description: step.description,
      prompt: step.prompt,
      model: commandLine.model ?? UNNAMED_MODEL,
      outputFile: surroundings.taskFiles(agent.id).outputFile,
    };
    task = { agent, step, launched, toolUseId: call.id, startedAt: Date.now(), working: false };
    await running.during(fire(subagentStart(agent), running.signal));
    await running.during(fire(postToolUse(call, launchedTaskResponse(launched)), running.signal));
    if (hooks.configures('PostToolBatch')) {
      await running.during(fire(postToolBatch(call, launchedTaskResult(launched)), running.signal));
    }
    running.toolCallOpen = false;
  }

  /** Lets the pending task work, once the turn that started it ended and the test lets it. */
  function startPendingTask(): void {
    if (task === undefined || task.working || ending) return;
    const pending = task;
    pending.working = true;
    void surroundings
      .tasksReleased()
      .then(() => runTask(pending))
      .catch((error: unknown) => fail(messageOf(error)));
  }

  /**
   * Plays a subagent's work: its calls, each with no ask and its hooks
   * naming the subagent, then its end, which starts the session's own turn
   * with a `<task-notification>` prompt. Seen of Claude Code: the subagent's
   * hooks carry the session's last prompt id, and its `SubagentStop` still
   * lists it as running.
   */
  async function runTask(pending: PendingTask): Promise<void> {
    const { agent, step } = pending;
    const calls = step.work.filter((work): work is ToolStep => work.do === 'tool');
    for (const call of calls) await runSubagentCall(agent, call);
    const reply = step.work.at(-1) as { readonly text: string };
    const files = surroundings.taskFiles(agent.id);
    await fire(
      subagentStop(agent, {
        transcriptPath: files.transcriptPath,
        lastAssistantMessage: reply.text,
        backgroundTasks: backgroundTasks(),
      }),
    );
    task = undefined;
    subagentEnded = true;
    const notification = taskNotification({
      ...pending.launched,
      toolUseId: pending.toolUseId,
      result: reply.text,
      toolUses: calls.length,
      durationMs: Date.now() - pending.startedAt,
    });
    // Whether the history shows the turn a task started was not observed.
    history = undefined;
    if (!ending) startTurnOn(notification);
  }

  /**
   * Plays a call of a subagent's.
   *
   * @throws `Error` for a call that would ask, or that a `PreToolUse` hook decides: neither was observed.
   */
  async function runSubagentCall(agent: Subagent, step: ToolStep): Promise<void> {
    const planned = planCall(step);
    const isAllowed = allowsEveryCallOf(surroundings.allowRules, planned.name);
    if (planned.routeIn(commandLine.permissionMode, isAllowed) !== 'run') {
      throw new Error(`a subagent's ${planned.name} call that does not run unasked: not observed`);
    }
    toolCalls += 1;
    const call = { id: `toolu_fake_${toolCalls}`, name: planned.name, input: planned.input };
    const before = await fire(bySubagent(agent, preToolUse(call)));
    if (before.behavior !== 'none')
      throw new Error("a PreToolUse hook decides on a subagent's call: not observed");
    await fire(bySubagent(agent, postToolUse(call, planned.responseTo(call.input))));
    if (hooks.configures('PostToolBatch')) {
      await fire(bySubagent(agent, postToolBatch(call, planned.resultOf(call.input))));
    }
  }

  /**
   * Compacts the conversation on the person's `/compact`, seen of Claude
   * Code: the command is a prompt of its own to the hooks (a new prompt id)
   * with no `UserPromptSubmit`; `PreCompact`; then the compaction is done,
   * fails, or stays until the person's Esc, as the script says. Once it
   * ended, the transcript records the command.
   * A conversation with nothing in it is refused: Claude Code was seen to
   * fire `PreCompact` alone or nothing, by when the command was typed.
   */
  async function compact(): Promise<void> {
    if (promptsTaken === 0) {
      fail(
        `${COMPACT_COMMAND} on a conversation with nothing in it: what Claude Code fires then depends on when it is typed`,
      );
      return;
    }
    state = 'busy';
    compacting = true;
    lastPrompt = COMPACT_COMMAND;
    show();
    try {
      promptId = randomUUID();
      await compactConversation();
    } catch (error) {
      fail(messageOf(error));
      return;
    }
    state = 'idle';
    compacting = false;
    show();
  }

  async function compactConversation(): Promise<void> {
    const [step] = turnAt(surroundings.readScript(), promptsTaken);
    if (step === undefined || !COMPACTIONS.includes(step.do)) {
      throw new Error(`${COMPACT_COMMAND} meets a turn of the script that does not compact`);
    }
    promptsTaken += 1;
    const end = endOf(step as Compaction);
    await fire(preCompact());
    await end();
  }

  /**
   * How a compaction ends, as the script says. One that stays takes the
   * person's Esc from now on: a test presses it as soon as `PreCompact` is told.
   */
  function endOf(step: Compaction): () => Promise<void> {
    switch (step.do) {
      case 'compact':
        return () => completeCompaction(step.summary);
      case 'compact-fails':
        return () => failCompaction(step.status);
      case 'compact-stays': {
        const escaped = new Promise<void>((resolve) => {
          interruptCompaction = resolve;
        });
        return () => endOnEscape(escaped);
      }
    }
  }

  /**
   * Seen of Claude Code: the compaction's two helpers end (`SubagentStop`,
   * of no type); the session starts again from the summary (`SessionStart`,
   * `compact`); `PostCompact` gives the summary.
   */
  async function completeCompaction(summary: string): Promise<void> {
    for (const helper of [drawAgentId(), drawAgentId()]) {
      const agent = { id: helper, type: '' };
      await fire(
        subagentStop(agent, {
          transcriptPath: surroundings.taskFiles(helper).transcriptPath,
          lastAssistantMessage: summary,
          backgroundTasks: backgroundTasks(),
        }),
      );
    }
    await fire(sessionStart({ source: 'compact', model: commandLine.model ?? UNNAMED_MODEL }));
    await fire(postCompact(summary));
    transcript.recordCommand({ name: 'compact', output: COMPACTED });
  }

  /**
   * Seen of Claude Code, its retries off: `StopFailure` of the compaction's
   * own agent, no `PostCompact`, and the error recorded as the command's.
   */
  async function failCompaction(status: number): Promise<void> {
    const failure = failureOf(status, surroundings.apiBaseUrl);
    await fire(compactionFailure(drawAgentId(), failure.error, failure.message));
    transcript.recordCommand({
      name: 'compact',
      error: `Error during compaction: ${failure.message}`,
    });
  }

  /**
   * Waits for the person's Esc, then ends as Claude Code was seen to: with
   * no hook, the caveat alone in the transcript, and `/compact` back in the
   * input box, its argument's hint after it.
   */
  async function endOnEscape(escaped: Promise<void>): Promise<void> {
    await escaped;
    interruptCompaction = undefined;
    transcript.recordCommand({ interrupted: true });
    box.putBack(COMPACT_COMMAND);
    commandPutBack = true;
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
   * @throws `Error` for a call that names a path the settings deny.
   */
  async function playCall(planned: PlannedCall, running: RunningTurn): Promise<void> {
    const denied = deniedPathNamedBy(planned.input, surroundings.deniedPaths);
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
    let answer: (outcome: AskOutcome) => void = () => {};
    const fromTerminal = new Promise<AskOutcome>((resolve) => {
      answer = resolve;
    });
    const open: OpenDialog = {
      shown: { kind: planned.dialog, toolName: planned.name },
      answerInTerminal: () => answer({ runsWith: planned.inputFromTerminal() }),
    };
    // Seen of Claude Code: a question shows as it is asked; a permission dialog a while after its hook.
    if (planned.dialog === 'question') draw(open);
    const fromHooks = fire(asked, running.signal).then(
      (decision) => outcomeOf(decision, planned) ?? fromTerminal,
    );
    // The hook stays open after an answer in the terminal: what it answers then is still read.
    fromHooks.catch((error: unknown) => fail(messageOf(error)));
    const drawing =
      planned.dialog === 'permission'
        ? setTimeout(() => draw(open), PERMISSION_DIALOG_DELAY_MS)
        : undefined;
    const outcome = await running
      .during(Promise.race([fromTerminal, fromHooks]))
      .finally(() => clearTimeout(drawing));
    dialog = undefined;
    state = 'busy';
    show();
    return outcome;
  }

  /** Draws a dialog over the input box, which takes the keys from now on. */
  function draw(open: OpenDialog): void {
    dialog = open;
    state = 'waiting';
    show();
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

/**
 * Gives the prompt Claude Code takes from the input box's text. Seen of it:
 * blanks and line breaks at the end are trimmed, those at the start kept,
 * and the invisible separator at either end dropped.
 *
 * @throws `Error` for an invisible separator inside the text: what becomes of it was not observed.
 */
export function promptOf(text: string): string {
  const separators = /^\u2063+|\u2063+$/g;
  const unmarked = text.replace(separators, '');
  if (unmarked.includes('\u2063')) {
    throw new Error(
      'an invisible separator inside a prompt: what Claude Code makes of it was not observed',
    );
  }
  return unmarked.replace(/[ \n]+$/, '');
}

/** Seen of Claude Code: text typed on a permission dialog does nothing; a digit alone may choose an option. */
function isIgnoredOn(shown: Dialog, key: Key): boolean {
  return shown.kind === 'permission' && key.kind === 'text' && !/^\d$/.test(key.text);
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
