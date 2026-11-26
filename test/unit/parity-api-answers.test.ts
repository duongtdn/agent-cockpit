import { expect, it } from 'vitest';
import type { Question } from '../support/fake-agent/script.ts';
import { apiError, heldTurn, toolUse, turn } from '../support/fake-api/index.ts';
import { apiAnswersFor, subagentAnswersFor } from '../support/parity/api-answers.ts';

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

const task = {
  do: 'task',
  description: 'Count files',
  prompt: 'Count the files.',
  agentType: 'general-purpose',
  work: [
    { do: 'tool', name: 'Bash', input: { command: 'ls' } },
    { do: 'reply', text: 'Two.' },
  ],
} as const;

it('answers a failure with its error, a task with its Agent call, a compaction with its two summaries', () => {
  const answers = apiAnswersFor([
    [{ do: 'fail', status: 529 }],
    [task, { do: 'reply', text: 'Started.' }],
    [{ do: 'compact', summary: 'The summary.' }],
  ]);

  expect(answers).toEqual([
    apiError(529),
    turn(
      toolUse('Agent', {
        description: 'Count files',
        prompt: 'Count the files.',
        subagent_type: 'general-purpose',
      }),
    ),
    turn('Started.'),
    turn('The summary.'),
    turn('The summary.'),
  ]);
});

it("answers a task's work in its own conversation, named by its prompt, its first answer held", () => {
  expect(subagentAnswersFor([[task, { do: 'reply', text: 'Started.' }]])).toEqual([
    {
      prompt: 'Count the files.',
      answers: [heldTurn(turn(toolUse('Bash', { command: 'ls' }))), turn('Two.')],
    },
  ]);
});
