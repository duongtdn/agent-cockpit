import { describe, expect, it } from 'vitest';
import { parseScript } from '../support/fake-agent/script.ts';

const read = (steps: unknown, prompt?: string) => parseScript(JSON.stringify(steps), prompt);

describe("the fake agent's script", () => {
  it('reads a turn on the launch prompt, a hold, then the exit', () => {
    const steps = [{ do: 'turn', reply: 'Done.' }, { do: 'hold' }, { do: 'exit' }];

    expect(read(steps, 'Explain a.ts')).toEqual(steps);
  });

  it('reads a turn that asks for its calls on the way, each a tool and its input', () => {
    const steps = [
      {
        do: 'turn',
        reply: 'Done.',
        asks: [
          { tool: 'Bash', input: { command: 'touch a.txt', description: 'Create a.txt' } },
          { tool: 'Write', input: { file_path: '/work/b.txt', content: 'b' } },
        ],
      },
    ];

    expect(read(steps, 'Make a.txt and b.txt')).toEqual(steps);
  });

  it('reads a launch with no prompt that only waits, or no script at all', () => {
    expect(read([{ do: 'hold' }, { do: 'exit' }])).toEqual([{ do: 'hold' }, { do: 'exit' }]);
    expect(read([])).toEqual([]);
  });

  it.each([
    ['what is no list', { do: 'exit' }, undefined, 'a script is a list of steps'],
    ['a step it does not play', [{ do: 'type', text: 'hi' }], 'hi', 'step 1 cannot be played'],
    ['a turn with no reply', [{ do: 'turn' }], 'hi', 'step 1 cannot be played'],
    ['a step with a field of no use', [{ do: 'exit', status: 3 }], undefined, 'step 1 cannot'],
    ['a turn with a field of no use', [{ do: 'turn', reply: 'a', at: 1 }], 'hi', 'step 1 cannot'],
    ['asks that are no list', [{ do: 'turn', reply: 'a', asks: {} }], 'hi', 'step 1 cannot'],
    [
      'an ask with no tool',
      [{ do: 'turn', reply: 'a', asks: [{ input: {} }] }],
      'hi',
      'step 1 cannot be played',
    ],
    [
      'an ask whose input is no object',
      [{ do: 'turn', reply: 'a', asks: [{ tool: 'Bash', input: 'ls' }] }],
      'hi',
      'step 1 cannot be played',
    ],
    [
      'an ask with a field of no use',
      [{ do: 'turn', reply: 'a', asks: [{ tool: 'Bash', input: {}, answer: 'allow' }] }],
      'hi',
      'step 1 cannot be played',
    ],
    ['a turn with no launch prompt', [{ do: 'turn', reply: 'Done.' }], undefined, 'gave none'],
    ['a launch prompt no step takes', [{ do: 'hold' }], 'hi', 'no step takes it'],
    [
      'a second prompt, which only an input box could take',
      [
        { do: 'turn', reply: 'a' },
        { do: 'turn', reply: 'b' },
      ],
      'hi',
      'step 2 takes a prompt',
    ],
    ['a prompt taken after the first step', [{ do: 'hold' }, { do: 'stay-busy' }], 'hi', 'step 2'],
    ['a step after the exit', [{ do: 'exit' }, { do: 'hold' }], undefined, 'goes on after step 1'],
    [
      'a step after staying busy',
      [{ do: 'stay-busy' }, { do: 'exit' }],
      'hi',
      'goes on after step 1',
    ],
  ])('refuses %s', (_what, steps, prompt, problem) => {
    expect(() => read(steps, prompt)).toThrow(problem);
  });
});
