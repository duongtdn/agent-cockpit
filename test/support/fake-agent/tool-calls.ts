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
  /** Tells what a permission mode does with the call. */
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
    routeIn: (mode) => (mode === 'default' ? 'ask' : mode === 'dontAsk' ? 'deny' : 'run'),
    isSettledBy: () => true,
    inputFromTerminal: () => step.input,
    responseTo: () => step.response ?? {},
  };
}

function planQuestion(step: QuestionStep): PlannedCall {
  const input = { questions: step.questions };
  return {
    name: 'AskUserQuestion',
    input,
    dialog: 'question',
    routeIn: (mode) => (mode === 'dontAsk' ? 'deny' : 'ask'),
    isSettledBy: (allowed) => allowed.answers !== undefined,
    inputFromTerminal: () => ({ ...input, answers: firstOptions(step) }),
    responseTo: (answered) => ({ answers: answered.answers }),
  };
}

/** The answers of a person who presses Enter on each question: its first option. */
function firstOptions(step: QuestionStep): Record<string, string> {
  return Object.fromEntries(
    step.questions.map((question) => [question.question, question.options[0]?.label ?? '']),
  );
}
