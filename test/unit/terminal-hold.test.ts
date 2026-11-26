import { beforeEach, expect, it } from 'vitest';
import {
  createTerminalHolds,
  type HeldTerminal,
  type TerminalHolds,
} from '../../src/server/terminal-hold.ts';

/** A terminal of the bridge's that records what the holds told it. */
function recordingTerminal(): HeldTerminal & { told: string[] } {
  const told: string[] = [];
  return { told, hold: () => told.push('hold'), release: () => told.push('release') };
}

let holds: TerminalHolds;

beforeEach(() => {
  holds = createTerminalHolds();
});

it('holds every terminal of the key, and only of that key, until released', () => {
  const first = recordingTerminal();
  const second = recordingTerminal();
  const other = recordingTerminal();
  holds.join('explain-a', first);
  holds.join('explain-a', second);
  holds.join('explain-b', other);

  const release = holds.hold('explain-a');
  expect([first.told, second.told, other.told]).toEqual([['hold'], ['hold'], []]);

  release();
  expect([first.told, second.told, other.told]).toEqual([
    ['hold', 'release'],
    ['hold', 'release'],
    [],
  ]);
});

it('holds a terminal that joins while the key is held, at once', () => {
  const release = holds.hold('explain-a');
  const late = recordingTerminal();

  holds.join('explain-a', late);
  expect(late.told).toEqual(['hold']);

  release();
  expect(late.told).toEqual(['hold', 'release']);
});

it('tells nothing to a terminal that joins while the key is not held', () => {
  const terminal = recordingTerminal();

  holds.join('explain-a', terminal);

  expect(terminal.told).toEqual([]);
});

it('tells nothing more to a terminal that left', () => {
  const terminal = recordingTerminal();
  const leave = holds.join('explain-a', terminal);
  const release = holds.hold('explain-a');

  leave();
  release();
  holds.hold('explain-a');

  expect(terminal.told).toEqual(['hold']);
});

it('releases once: a second call does nothing', () => {
  const terminal = recordingTerminal();
  holds.join('explain-a', terminal);
  const release = holds.hold('explain-a');

  release();
  release();
  const next = holds.hold('explain-a');

  expect(terminal.told).toEqual(['hold', 'release', 'hold']);
  next();
});

it('keeps the keys held until the last of two holds of the key is released', () => {
  const terminal = recordingTerminal();
  holds.join('explain-a', terminal);
  const first = holds.hold('explain-a');
  const second = holds.hold('explain-a');

  first();
  expect(terminal.told).toEqual(['hold']);
  first();
  expect(terminal.told).toEqual(['hold']);

  second();
  expect(terminal.told).toEqual(['hold', 'release']);
});
