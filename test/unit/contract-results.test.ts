import { describe, expect, it } from 'vitest';
import { behaviorResults, contractResults } from '../contract/results.ts';

describe("the contract suite's results", () => {
  it('give each behavior its number, its title and whether its test passed', () => {
    const results = behaviorResults([
      { name: '7 — A normal turn end fires Stop', state: 'failed' },
      { name: '1 — SessionStart arrives as a command hook', state: 'passed' },
      { name: '12 — The TUI shows no question — until asked', state: 'passed' },
    ]);

    expect(results).toEqual([
      { number: 1, title: 'SessionStart arrives as a command hook', result: 'pass' },
      { number: 7, title: 'A normal turn end fires Stop', result: 'fail' },
      { number: 12, title: 'The TUI shows no question — until asked', result: 'pass' },
    ]);
  });

  it('leave out a test that is no behavior and a test that did not run', () => {
    const results = behaviorResults([
      { name: 'refuses to launch', state: 'passed' },
      { name: '3 — Resume keeps the conversation', state: 'skipped' },
      { name: '4 — Early keys lose their Enter', state: 'pending' },
    ]);

    expect(results).toEqual([]);
  });

  it("carry the agent's version and the date of the run", () => {
    const results = contractResults('2.1.332', new Date('2026-11-26T05:00:00.000Z'), [
      { name: '5 — A submitted prompt fires UserPromptSubmit', state: 'passed' },
    ]);

    expect(results).toEqual({
      agent: 'claude-code',
      agentVersion: '2.1.332',
      date: '2026-11-26T05:00:00.000Z',
      behaviors: [
        { number: 5, title: 'A submitted prompt fires UserPromptSubmit', result: 'pass' },
      ],
      lostEnters: [],
    });
  });

  it('list every Enter the agent lost, in any test, whatever its outcome', () => {
    const results = contractResults('2.1.332', new Date('2026-11-26T05:00:00.000Z'), [
      {
        name: '5 — A submitted prompt fires UserPromptSubmit',
        state: 'passed',
        lostEnters: [{ prompt: 'typed into the terminal', lost: 1 }],
      },
      { name: '7 — A normal turn end fires Stop', state: 'passed', lostEnters: [] },
      {
        name: 'a typed prompt, answered after a tool call',
        state: 'failed',
        lostEnters: [
          { prompt: 'touch it', lost: 2 },
          { prompt: 'go on', lost: 1 },
        ],
      },
    ]);

    expect(results.lostEnters).toEqual([
      {
        test: '5 — A submitted prompt fires UserPromptSubmit',
        prompt: 'typed into the terminal',
        lost: 1,
      },
      { test: 'a typed prompt, answered after a tool call', prompt: 'touch it', lost: 2 },
      { test: 'a typed prompt, answered after a tool call', prompt: 'go on', lost: 1 },
    ]);
  });
});
