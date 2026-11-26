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
   * @throws `Error` naming the tool and the mode when nothing observed of
   * Claude Code tells: the fake agent plays no guess.
   */
  routeIn(mode: string): Route;
  /** Tells whether an allowed input lets the call run: a question needs its answers. */
  isSettledBy(input: ToolInput): boolean;
  /** Gives the input the call runs with when the person says yes in the terminal. */
  inputFromTerminal(): ToolInput;
  /** Gives what the tool answers when it ran with an input. */
  responseTo(input: ToolInput): unknown;
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
    routeIn: (mode) => routeOfTool(step, mode),
    isSettledBy: () => true,
    inputFromTerminal: () => step.input,
    responseTo: () => step.response ?? {},
  };
}

function planQuestion(step: QuestionStep): PlannedCall {
  const input = { questions: step.questions };
  return {
    name: QUESTION_TOOL,
    input,
    dialog: 'question',
    routeIn: (mode) => routeOfQuestion(mode),
    isSettledBy: (allowed) => allowed.answers !== undefined,
    inputFromTerminal: () => ({ ...input, answers: firstOptions(step) }),
    responseTo: (answered) => ({ answers: answered.answers }),
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
 * modes the tools differ, and only a `touch` was seen: it runs.
 */
function routeOfTool(step: ToolStep, mode: string): Route {
  if (mode === 'default') return 'ask';
  if (mode === 'dontAsk') return 'deny';
  if (MODES_THAT_RUN_A_TOUCH.includes(mode) && isATouch(step)) return 'run';
  throw noKnownRoute(step.name, mode);
}

function routeOfQuestion(mode: string): Route {
  if (MODES_BESIDE_DONT_ASK.includes(mode)) return 'ask';
  if (mode === 'dontAsk') return 'deny';
  throw noKnownRoute(QUESTION_TOOL, mode);
}

function noKnownRoute(toolName: string, mode: string): Error {
  return new Error(
    `nothing tells what Claude Code does with a call of ${toolName} in the ${mode} mode`,
  );
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
