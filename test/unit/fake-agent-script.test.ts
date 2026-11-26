import { describe, expect, it } from 'vitest';
import { parseScript, turnAt } from '../support/fake-agent/script.ts';
import { planCall } from '../support/fake-agent/tool-calls.ts';

const questions = [
  {
    question: 'Which fruit?',
    header: 'Fruit',
    options: [
      { label: 'Mango', description: 'Sweet.' },
      { label: 'Lime', description: 'Sour.' },
    ],
    multiSelect: false,
  },
];

describe("the fake agent's script", () => {
  it('is a list of turns, each a list of steps', () => {
    const turns = [
      [
        { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } },
        { do: 'question', questions },
        { do: 'reply', text: 'Done.' },
      ],
      [{ do: 'stay-busy' }],
      [{ do: 'exit' }],
    ];

    expect(parseScript(JSON.stringify(turns))).toEqual(turns);
  });

  it('gives each prompt of the conversation its turn, by its place', () => {
    const turns = parseScript(
      JSON.stringify([[{ do: 'reply', text: 'One.' }], [{ do: 'reply', text: 'Two.' }]]),
    );

    expect(turnAt(turns, 1)).toEqual([{ do: 'reply', text: 'Two.' }]);
  });

  it('answers a prompt beyond the script with a plain reply', () => {
    expect(turnAt([], 0)).toEqual([{ do: 'reply', text: 'Done.' }]);
  });

  it.each([
    ['what is no list of turns', '{}', 'a list of turns'],
    ['a turn that is no list of steps', '[{}]', 'turn 1 is no list of steps'],
    ['an empty turn', '[[]]', 'turn 1 has no step'],
    ['a step it cannot play', '[[{"do":"think"}]]', 'turn 1, step 1'],
    ['a reply without a text', '[[{"do":"reply"}]]', 'turn 1, step 1'],
    ['a tool without an input', '[[{"do":"tool","name":"Bash"},{"do":"exit"}]]', 'turn 1, step 1'],
    ['a question without questions', '[[{"do":"question"},{"do":"exit"}]]', 'turn 1, step 1'],
    [
      'a turn that does not end',
      '[[{"do":"tool","name":"Bash","input":{}}]]',
      'turn 1 must end with a reply, stay-busy or exit',
    ],
    [
      'a step after the end of its turn',
      '[[{"do":"reply","text":"a"},{"do":"reply","text":"b"}]]',
      'turn 1 goes on after step 1',
    ],
  ])('refuses %s', (_what, text, message) => {
    expect(() => parseScript(text)).toThrow(message);
  });
});

describe('a call the script asks for, as the fake agent plays it', () => {
  const tool = planCall({ do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } });
  const question = planCall({ do: 'question', questions });

  it('a tool asks for permission in the default mode, is denied in dontAsk, runs in the others', () => {
    expect(tool.routeIn('default')).toBe('ask');
    expect(tool.routeIn('dontAsk')).toBe('deny');
    expect(['acceptEdits', 'auto', 'bypassPermissions', 'plan'].map(tool.routeIn)).toEqual([
      'run',
      'run',
      'run',
      'run',
    ]);
  });

  it('a question is asked in every mode but dontAsk, which denies it', () => {
    expect(
      ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'].map(question.routeIn),
    ).toEqual(['ask', 'ask', 'ask', 'ask', 'ask']);
    expect(question.routeIn('dontAsk')).toBe('deny');
  });

  it('a question is the AskUserQuestion tool with its questions as input', () => {
    expect(question).toMatchObject({
      name: 'AskUserQuestion',
      input: { questions },
      dialog: 'question',
    });
    expect(tool).toMatchObject({ name: 'Bash', dialog: 'permission' });
  });

  it('a tool is settled by any allow; a question only by an input with answers (behavior 13)', () => {
    expect(tool.isSettledBy({ command: 'touch a.txt' })).toBe(true);
    expect(question.isSettledBy({ questions })).toBe(false);
    expect(question.isSettledBy({ questions, answers: { 'Which fruit?': 'Lime' } })).toBe(true);
  });

  it('a question answered in the terminal takes the first option of each question', () => {
    expect(question.inputFromTerminal()).toEqual({
      questions,
      answers: { 'Which fruit?': 'Mango' },
    });
    expect(tool.inputFromTerminal()).toEqual({ command: 'touch a.txt' });
  });

  it('a tool answers what the script says; a question answers with its answers', () => {
    const scripted = planCall({ do: 'tool', name: 'Bash', input: {}, response: { stdout: 'hi' } });
    const answers = { 'Which fruit?': 'Lime' };

    expect(scripted.responseTo({})).toEqual({ stdout: 'hi' });
    expect(tool.responseTo({})).toEqual({});
    expect(question.responseTo({ questions, answers })).toEqual({ answers });
  });
});
