import type { ReplyStep, Step, TaskStep, ToolStep, Turn } from '../fake-agent/script.ts';
import {
  type Turn as ApiTurn,
  apiError,
  heldTurn,
  type ScriptedAnswer,
  toolUse,
  turn,
} from '../fake-api/index.ts';

/**
 * Gives the answers that make the real agent play a script of the fake
 * agent's, in the session's own conversation: the model's side of each
 * step, in order. A tool or a question is a turn of the model that calls
 * it, a reply a turn that says it, a turn that stays busy a turn the API
 * holds, a failure the API's error, a task a turn that calls `Agent`, and a
 * compaction the summary its two helpers write. A task's own work is
 * another conversation's: see {@link subagentAnswersFor}.
 *
 * @param script - The fake agent's script.
 * @returns What the API's double is scripted with.
 * @throws Error for a step no answer of the API makes the real agent play: an exit.
 */
export function apiAnswersFor(script: readonly Turn[]): ScriptedAnswer[] {
  return script.flat().flatMap(answersFor);
}

function answersFor(step: Step): ScriptedAnswer[] {
  switch (step.do) {
    case 'reply':
    case 'tool':
      return [answerFor(step)];
    case 'question':
      return [turn(toolUse('AskUserQuestion', { questions: step.questions }))];
    case 'stay-busy':
      return [heldTurn()];
    case 'fail':
      return [apiError(step.status)];
    case 'task':
      return [turn(toolUse('Agent', agentInput(step)))];
    case 'compact':
      return [turn(step.summary), turn(step.summary)];
    case 'exit':
      throw new Error(
        'No answer of the API makes the real agent leave: an exit cannot be compared.',
      );
  }
}

function answerFor(step: ToolStep | ReplyStep): ApiTurn {
  return step.do === 'reply' ? turn(step.text) : turn(toolUse(step.name, step.input));
}

function agentInput(step: TaskStep): Record<string, unknown> {
  return { description: step.description, prompt: step.prompt, subagent_type: step.agentType };
}

/** The answers of a subagent's own conversation, which its prompt names. */
export interface SubagentAnswers {
  readonly prompt: string;
  readonly answers: readonly ScriptedAnswer[];
}

/**
 * Gives the answers of the subagents a script starts, each in its own
 * conversation. The first is held, as the fake agent holds a task: the
 * subagent works once the test lets it.
 *
 * @param script - The fake agent's script.
 * @returns For each task, its prompt and its answers.
 */
export function subagentAnswersFor(script: readonly Turn[]): SubagentAnswers[] {
  return script
    .flat()
    .filter((step): step is TaskStep => step.do === 'task')
    .map((task) => {
      const [first, ...rest] = task.work.map(answerFor) as [ApiTurn, ...ApiTurn[]];
      return { prompt: task.prompt, answers: [heldTurn(first), ...rest] };
    });
}
