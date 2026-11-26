import type { ToolInput } from './hook-events.ts';
import type { QuestionStep, ToolStep } from './script.ts';

/** What happens to a call no `PreToolUse` hook settled: a dialog asks, it runs unasked, or it is denied unasked. */
export type Route = 'ask' | 'run' | 'deny';

/** A tool call of the script, with what tells a tool from a question. */
export interface PlannedCall {
  /** The tool's name. */
  readonly name: string;
  /** What the tool is called with. */
  readonly input: ToolInput;
  /** The dialog the terminal shows when the call asks. */
  readonly dialog: 'permission' | 'question';
  /**
   * Tells what a permission mode does with the call.
   *
   * @param mode - The session's mode.
   * @param isAllowed - Whether the settings allow the tool, whatever it is called with.
   * @throws `Error` naming the tool and the mode when nothing observed of
   * Claude Code tells: the fake agent plays no guess.
   */
  routeIn(mode: string, isAllowed: boolean): Route;
  /**
   * Gives the rules the ask of the call offers to add, as `PermissionRequest` tells them.
   *
   * @param workFolder - The folder the session runs in.
   * @returns The suggestions; `undefined` for an ask that carries none.
   * @throws `Error` naming the call when what Claude Code suggests for it was not observed.
   */
  suggestionsIn(workFolder: string): readonly object[] | undefined;
  /** Tells whether an allowed input lets the call run: a question needs its answers. */
  isSettledBy(input: ToolInput): boolean;
  /** Gives the input the call runs with when the person says yes in the terminal. */
  inputFromTerminal(): ToolInput;
  /** Gives what the tool answers when it ran with an input. */
  responseTo(input: ToolInput): unknown;
  /**
   * Gives what the model is told of the call once it ran with an input.
   *
   * @throws `Error` naming the tool when the script does not say.
   */
  resultOf(input: ToolInput): string;
}

/**
 * Plans a call the script asks for.
 *
 * @param step - A tool step, or a question step: a call of `AskUserQuestion`.
 * @returns The call, as the fake agent plays it.
 */
export function planCall(step: ToolStep | QuestionStep): PlannedCall {
  return step.do === 'tool' ? planTool(step) : planQuestion(step);
}

function planTool(step: ToolStep): PlannedCall {
  return {
    name: step.name,
    input: step.input,
    dialog: 'permission',
    routeIn: (mode, isAllowed) => routeOfTool(step, mode, isAllowed),
    suggestionsIn: (workFolder) => suggestionsFor(step, workFolder),
    isSettledBy: () => true,
    inputFromTerminal: () => step.input,
    responseTo: () => step.response ?? {},
    resultOf: () => resultIn(step),
  };
}

function planQuestion(step: QuestionStep): PlannedCall {
  const input = { questions: step.questions };
  return {
    name: QUESTION_TOOL,
    input,
    dialog: 'question',
    routeIn: (mode, isAllowed) => routeOfQuestion(mode, isAllowed),
    suggestionsIn: () => undefined,
    isSettledBy: (allowed) => allowed.answers !== undefined,
    // Seen of Claude Code: its dialog adds the notes of the person, none for an Enter.
    inputFromTerminal: () => ({ ...input, answers: firstOptions(step), annotations: {} }),
    // Seen of Claude Code: the tool answers the input it ran with.
    responseTo: (answered) => answered,
    resultOf: (answered) => answersTold(answered.answers as Readonly<Record<string, string>>),
  };
}

/** The tool a question is a call of. */
const QUESTION_TOOL = 'AskUserQuestion';

/** The modes in which a `touch` was seen to run with no ask. */
const MODES_THAT_RUN_A_TOUCH: readonly string[] = [
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
];

/** Every mode but `dontAsk`: a question is asked in each. */
const MODES_BESIDE_DONT_ASK: readonly string[] = ['default', ...MODES_THAT_RUN_A_TOUCH];

/** A shell command that only touches files named plainly: the one command whose fate is known in every mode. */
const A_TOUCH = /^touch( [\w./-]+)+$/;

/**
 * Tells what a mode does with a call that needs permission: it asks in
 * `default` and is denied in `dontAsk`, whatever the tool. In the other
 * modes the tools differ, and only a `touch` was seen: it runs. A tool the
 * settings allow was seen in `default` only: it runs with no ask.
 */
function routeOfTool(step: ToolStep, mode: string, isAllowed: boolean): Route {
  if (mode === 'default') return isAllowed ? 'run' : 'ask';
  if (isAllowed) throw noKnownRoute(`${step.name} that the settings allow`, mode);
  if (mode === 'dontAsk') return 'deny';
  if (MODES_THAT_RUN_A_TOUCH.includes(mode) && isATouch(step)) return 'run';
  throw noKnownRoute(step.name, mode);
}

function routeOfQuestion(mode: string, isAllowed: boolean): Route {
  if (isAllowed) throw noKnownRoute(`${QUESTION_TOOL} that the settings allow`, mode);
  if (MODES_BESIDE_DONT_ASK.includes(mode)) return 'ask';
  if (mode === 'dontAsk') return 'deny';
  throw noKnownRoute(QUESTION_TOOL, mode);
}

function noKnownRoute(toolName: string, mode: string): Error {
  return new Error(
    `nothing tells what Claude Code does with a call of ${toolName} in the ${mode} mode`,
  );
}

/**
 * Gives what the ask of a tool suggests. Only a `touch` was seen: to add
 * the session's folder, or to accept edits, for the session.
 */
function suggestionsFor(step: ToolStep, workFolder: string): readonly object[] {
  if (!isATouch(step)) {
    throw new Error(
      `nothing tells what Claude Code suggests when it asks about this call of ${step.name}, which a PermissionRequest hook is told`,
    );
  }
  return [
    { type: 'addDirectories', directories: [workFolder], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ];
}

function resultIn(step: ToolStep): string {
  if (step.result === undefined) {
    throw new Error(
      `the script gives the call of ${step.name} no "result", which a PostToolBatch hook is told`,
    );
  }
  return step.result;
}

/** What Claude Code tells the model of a question once it is answered. */
function answersTold(answers: Readonly<Record<string, string>>): string {
  const told = Object.entries(answers).map(([question, answer]) => `"${question}"="${answer}"`);
  return `Your questions have been answered: ${told.join(', ')}. You can now continue with these answers in mind.`;
}

/** What Claude Code tells the model of a call a `PermissionRequest` hook denied without a message. */
export const DENIED_BY_HOOK = 'Permission denied by hook';

/**
 * Gives what Claude Code tells the model of a call it denied, unasked, in the `dontAsk` mode.
 *
 * @param toolName - The tool's name.
 */
export function deniedInDontAsk(toolName: string): string {
  return `Permission to use ${toolName} has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If you believe this capability is essential to complete the user's request, STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.`;
}

function isATouch(step: ToolStep): boolean {
  const { command } = step.input;
  return step.name === 'Bash' && typeof command === 'string' && A_TOUCH.test(command);
}

/** The answers of a person who presses Enter on each question: its first option. */
function firstOptions(step: QuestionStep): Record<string, string> {
  return Object.fromEntries(
    step.questions.map((question) => [question.question, question.options[0]?.label ?? '']),
  );
}
