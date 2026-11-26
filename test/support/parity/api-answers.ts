import type { Step, Turn } from '../fake-agent/script.ts';
import { heldTurn, type ScriptedAnswer, toolUse, turn } from '../fake-api/index.ts';

/**
 * Gives the answers that make the real agent play a script of the fake
 * agent's: the model's side of each step, in order. A tool or a question is
 * a turn of the model that calls it, a reply a turn that says it, and a
 * turn that stays busy a turn the API holds.
 *
 * @param script - The fake agent's script.
 * @returns What the API's double is scripted with.
 * @throws Error for a step no answer of the API makes the real agent play: an exit.
 */
export function apiAnswersFor(script: readonly Turn[]): ScriptedAnswer[] {
  return script.flat().map(answerFor);
}

function answerFor(step: Step): ScriptedAnswer {
  switch (step.do) {
    case 'reply':
      return turn(step.text);
    case 'tool':
      return turn(toolUse(step.name, step.input));
    case 'question':
      return turn(toolUse('AskUserQuestion', { questions: step.questions }));
    case 'stay-busy':
      return heldTurn();
    case 'exit':
      throw new Error(
        'No answer of the API makes the real agent leave: an exit cannot be compared.',
      );
  }
}
