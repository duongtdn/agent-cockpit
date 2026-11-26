import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';

describe("the Claude Code driver's reading of the screen", () => {
  it('tells nothing of a blank screen: the agent has drawn nothing yet', () => {
    expect(claudeCode().readScreen('')).toEqual({ shows: 'nothing' });
    expect(claudeCode().readScreen('\n\n\n')).toEqual({ shows: 'nothing' });
  });
});
