import { expect, it } from 'vitest';
import type { Question } from '../support/fake-agent/script.ts';
import { heldTurn, toolUse, turn } from '../support/fake-api/index.ts';
import { apiAnswersFor } from '../support/parity/api-answers.ts';

const fruit: Question = {
  question: 'Which fruit?',
  header: 'Fruit',
  options: [{ label: 'Mango', description: 'Sweet.' }],
  multiSelect: false,
};

it('answers each step of a script as the model would, turn after turn', () => {
  const answers = apiAnswersFor([
    [
      { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } },
      { do: 'question', questions: [fruit] },
      { do: 'reply', text: 'Done.' },
    ],
    [{ do: 'stay-busy' }],
  ]);

  expect(answers).toEqual([
    turn(toolUse('Bash', { command: 'touch a.txt' })),
    turn(toolUse('AskUserQuestion', { questions: [fruit] })),
    turn('Done.'),
    heldTurn(),
  ]);
});

it('refuses an exit, which no answer of the API makes the real agent play', () => {
  expect(() => apiAnswersFor([[{ do: 'exit' }]])).toThrow(/exit cannot be compared/);
});
