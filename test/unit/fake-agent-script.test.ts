import { describe, expect, it } from 'vitest';
import { parseScript, turnAt } from '../support/fake-agent/script.ts';
import { DENIED_BY_HOOK, deniedInDontAsk, planCall } from '../support/fake-agent/tool-calls.ts';

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
        { do: 'tool', name: 'Bash', input: { command: 'ls' }, response: {}, result: 'a.txt' },
        { do: 'question', questions },
        { do: 'reply', text: 'Done.' },
      ],
      [{ do: 'stay-busy' }],
      [
        {
          do: 'task',
          description: 'Count files',
          prompt: 'Count the files.',
          agentType: 'general-purpose',
          work: [
            { do: 'tool', name: 'Bash', input: { command: 'ls' } },
            { do: 'reply', text: 'Two.' },
          ],
        },
        { do: 'fail', status: 529 },
      ],
      [{ do: 'compact', summary: 'The summary.' }],
      [{ do: 'compact-fails', status: 500 }],
      [{ do: 'compact-stays' }],
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

  it('has no turn for a prompt beyond it, and says so', () => {
    expect(() => turnAt([], 0)).toThrow('the script has no turn for prompt 1: it holds 0 turns');
    expect(() => turnAt([[{ do: 'exit' }]], 2)).toThrow(
      'the script has no turn for prompt 3: it holds 1 turn',
    );
  });

  it.each([
    ['what is no list of turns', '{}', 'a list of turns'],
    ['a turn that is no list of steps', '[{}]', 'turn 1 is no list of steps'],
    ['an empty turn', '[[]]', 'turn 1 has no step'],
    ['a step it cannot play', '[[{"do":"think"}]]', 'turn 1, step 1'],
    ['a reply without a text', '[[{"do":"reply"}]]', 'turn 1, step 1'],
    ['a tool without an input', '[[{"do":"tool","name":"Bash"},{"do":"exit"}]]', 'turn 1, step 1'],
    [
      'a tool whose result is no text',
      '[[{"do":"tool","name":"Bash","input":{},"result":{}},{"do":"exit"}]]',
      'turn 1, step 1',
    ],
    ['a question without questions', '[[{"do":"question"},{"do":"exit"}]]', 'turn 1, step 1'],
    [
      'a turn that does not end',
      '[[{"do":"tool","name":"Bash","input":{}}]]',
      'turn 1 must end with a reply, stay-busy, exit, fail or compact',
    ],
    ['a failure without its status', '[[{"do":"fail"}]]', 'turn 1, step 1'],
    ['a compaction without its summary', '[[{"do":"compact"}]]', 'turn 1, step 1'],
    ['a failed compaction without its status', '[[{"do":"compact-fails"}]]', 'turn 1, step 1'],
    [
      'a compaction until Esc with another step in its turn',
      '[[{"do":"reply","text":"r"},{"do":"compact-stays"}]]',
      'turn 1 goes on after step 1',
    ],
    [
      'a failed compaction with another step in its turn',
      '[[{"do":"tool","name":"Bash","input":{}},{"do":"compact-fails","status":500}]]',
      'turn 1 compacts: a compaction is a turn of its own',
    ],
    [
      'a compaction with another step in its turn',
      '[[{"do":"tool","name":"Bash","input":{}},{"do":"compact","summary":"s"}]]',
      'turn 1 compacts: a compaction is a turn of its own',
    ],
    [
      'a task whose work does not end with a reply',
      '[[{"do":"task","description":"d","prompt":"p","agentType":"t","work":[{"do":"tool","name":"Bash","input":{}}]},{"do":"exit"}]]',
      'turn 1, step 1',
    ],
    [
      'a task whose work asks a question',
      '[[{"do":"task","description":"d","prompt":"p","agentType":"t","work":[{"do":"question","questions":[]},{"do":"reply","text":"r"}]},{"do":"exit"}]]',
      'turn 1, step 1',
    ],
    [
      'a task without its type',
      '[[{"do":"task","description":"d","prompt":"p","work":[{"do":"reply","text":"r"}]},{"do":"exit"}]]',
      'turn 1, step 1',
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

  const otherModes = ['acceptEdits', 'auto', 'bypassPermissions', 'plan'];

  it('a tool asks for permission in the default mode and is denied in dontAsk', () => {
    const write = planCall({ do: 'tool', name: 'Write', input: { file_path: 'a.txt' } });

    expect([tool, write].map((call) => call.routeIn('default', false))).toEqual(['ask', 'ask']);
    expect([tool, write].map((call) => call.routeIn('dontAsk', false))).toEqual(['deny', 'deny']);
  });

  it('a touch runs unasked in the other modes', () => {
    expect(otherModes.map((mode) => tool.routeIn(mode, false))).toEqual([
      'run',
      'run',
      'run',
      'run',
    ]);
  });

  it('a tool the settings allow runs unasked in the default mode, the one it was seen in', () => {
    const write = planCall({ do: 'tool', name: 'Write', input: { file_path: 'a.txt' } });

    expect([tool, write].map((call) => call.routeIn('default', true))).toEqual(['run', 'run']);
    for (const mode of ['dontAsk', ...otherModes]) {
      expect(() => tool.routeIn(mode, true)).toThrow(
        `Bash that the settings allow in the ${mode} mode`,
      );
    }
  });

  it('a question the settings allow has no known route', () => {
    expect(() => question.routeIn('default', true)).toThrow(
      'AskUserQuestion that the settings allow in the default mode',
    );
  });

  it.each([
    ['another tool', { name: 'Write', input: { file_path: 'a.txt' } }],
    ['another command', { name: 'Bash', input: { command: 'rm a.txt' } }],
    ['a command that only begins like a touch', { name: 'Bash', input: { command: 'touchy a' } }],
    ['a touch followed by another command', { name: 'Bash', input: { command: 'touch a; rm b' } }],
    ['a command that is no text', { name: 'Bash', input: { command: 7 } }],
  ])('%s has no known route in the other modes', (_what, step) => {
    const call = planCall({ do: 'tool', ...step });

    for (const mode of otherModes) {
      expect(() => call.routeIn(mode, false)).toThrow(`${step.name} in the ${mode} mode`);
    }
  });

  it('a question is asked in every mode but dontAsk, which denies it', () => {
    expect(['default', ...otherModes].map((mode) => question.routeIn(mode, false))).toEqual([
      'ask',
      'ask',
      'ask',
      'ask',
      'ask',
    ]);
    expect(question.routeIn('dontAsk', false)).toBe('deny');
  });

  it('no call has a route in a mode that is not one of Claude Code', () => {
    expect(() => tool.routeIn('yolo', false)).toThrow('Bash in the yolo mode');
    expect(() => question.routeIn('yolo', false)).toThrow('AskUserQuestion in the yolo mode');
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

  it('a question answered in the terminal takes the first option of each question, and no note', () => {
    expect(question.inputFromTerminal()).toEqual({
      questions,
      answers: { 'Which fruit?': 'Mango' },
      annotations: {},
    });
    expect(tool.inputFromTerminal()).toEqual({ command: 'touch a.txt' });
  });

  it('a tool answers what the script says; a question answers the input it was answered with', () => {
    const scripted = planCall({ do: 'tool', name: 'Bash', input: {}, response: { stdout: 'hi' } });
    const answers = { 'Which fruit?': 'Lime' };

    expect(scripted.responseTo({})).toEqual({ stdout: 'hi' });
    expect(tool.responseTo({})).toEqual({});
    expect(question.responseTo({ questions, answers })).toEqual({ questions, answers });
  });

  it('the model is told of a tool what the script says, and nothing the script does not say', () => {
    const scripted = planCall({ do: 'tool', name: 'Bash', input: {}, result: 'hi' });

    expect(scripted.resultOf({})).toBe('hi');
    expect(() => tool.resultOf({})).toThrow(
      'the script gives the call of Bash no "result", which a PostToolBatch hook is told',
    );
  });

  it('the model is told of a question each answer, in the words of Claude Code', () => {
    const answers = { 'Which fruit?': 'Lime', 'Which drink?': 'Tea' };

    expect(question.resultOf({ questions, answers })).toBe(
      'Your questions have been answered: "Which fruit?"="Lime", "Which drink?"="Tea". You can now continue with these answers in mind.',
    );
  });

  it('the model is told of a refused call why, in the words of Claude Code', () => {
    expect(DENIED_BY_HOOK).toBe('Permission denied by hook');
    expect(deniedInDontAsk('Bash')).toMatch(
      /^Permission to use Bash has been denied because Claude Code is running in don't ask mode\. IMPORTANT: .* Let the user decide how to proceed\.$/,
    );
  });

  it('the ask of a touch suggests to add the folder or to accept edits; the ask of a question nothing', () => {
    expect(tool.suggestionsIn('/work')).toEqual([
      { type: 'addDirectories', directories: ['/work'], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    expect(question.suggestionsIn('/work')).toBeUndefined();
  });

  it('nothing tells what the ask of another call suggests', () => {
    const write = planCall({ do: 'tool', name: 'Write', input: { file_path: 'a.txt' } });

    expect(() => write.suggestionsIn('/work')).toThrow(
      'nothing tells what Claude Code suggests when it asks about this call of Write',
    );
  });
});
