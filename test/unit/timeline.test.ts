import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginTimeline,
  noteHook,
  noteKeys,
  noteScreen,
  noteState,
  timelineText,
  writeTimeline,
} from '../support/timeline.ts';

describe("a test's timeline", () => {
  let repository: string | undefined;
  afterEach(() => {
    if (repository !== undefined) rmSync(repository, { recursive: true, force: true });
  });

  it('keeps hooks, states and each screen as it changed, in order', () => {
    beginTimeline();
    noteScreen('say', 'one');
    noteHook('say', { hook_event_name: 'SessionStart' });
    noteScreen('say', 'one');
    noteScreen('other', 'one');
    noteState('say', 'idle');
    noteKeys('say', 'Down C-e');
    noteScreen('say', 'two\nlines');

    const lines = timelineText()
      .split('\n')
      .map((line) => line.replace(/^\+\s*\d+ ms {2}/u, ''));
    expect(lines).toEqual([
      'screen say',
      '    | one',
      'hook   say  {"hook_event_name":"SessionStart"}',
      'screen other',
      '    | one',
      'state  say  idle',
      'keys   say  Down C-e',
      'screen say',
      '    | two',
      '    | lines',
    ]);
  });

  it('starts empty for each test', () => {
    noteState('say', 'busy');
    beginTimeline();

    expect(timelineText()).toBe('');
  });

  it("is written under test-results, named by the test's file and title, only when something was seen", () => {
    repository = mkdtempSync(join(tmpdir(), 'timeline-'));
    beginTimeline();
    expect(writeTimeline(repository, join(repository, 'test/a.test.ts'), 'a > b')).toBeUndefined();

    noteState('say', 'idle');
    const path = writeTimeline(repository, join(repository, 'test/a.test.ts'), '7 — a: b');

    expect(path).toBe(join(repository, 'test-results/timelines/test-a.test.ts-7-a-b.txt'));
    expect(readFileSync(path ?? '', 'utf8')).toMatch(
      /^test\/a\.test\.ts > 7 — a: b\n\n\+ +\d+ ms {2}state {2}say {2}idle\n$/u,
    );
  });
});
