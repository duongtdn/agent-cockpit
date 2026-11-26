import { describe, expect, it } from 'vitest';
import { layOut } from '../support/fake-agent/box-layout.ts';
import { createInputBox, type InputBox } from '../support/fake-agent/input-box.ts';
import type { Key } from '../support/fake-agent/keys.ts';

/**
 * The shapes here are those Claude Code 2.1.332 was seen to draw in a
 * terminal of 120×40, the size the box was observed at: its text wraps at
 * 116 columns, and 15 rows show at most.
 */

const SEPARATOR = '⁣';
const text = (value: string): Key => ({ kind: 'text', text: value });
const lineBreak: Key = { kind: 'line-break' };
const kill: Key = { kind: 'kill-line' };
const yank: Key = { kind: 'yank' };
const up: Key = { kind: 'up' };
const down: Key = { kind: 'down' };
const endOfLine: Key = { kind: 'end-of-line' };
const backspace: Key = { kind: 'backspace' };

/** Seventy words of nine characters, as a person's one long line: six rows. */
const LONG_LINE = Array.from({ length: 70 }, (_, i) => `word${String(i).padStart(3, '0')}x`).join(
  ' ',
);

function draftLines(count: number, letters = 0): string {
  const tail =
    letters > 0 ? ` ${'abcdefghij'.repeat(Math.ceil(letters / 10)).slice(0, letters)}` : '';
  return Array.from(
    { length: count },
    (_, i) => `draft line ${String(i + 1).padStart(2, '0')}${tail}`,
  ).join('\n');
}

/** The keys a person types a text with, a line break as ESC CR. */
function typing(value: string): Key[] {
  return value
    .split('\n')
    .flatMap((line, index): Key[] => [...(index > 0 ? [lineBreak] : []), text(line)]);
}

function boxAfter(keys: readonly Key[], history?: readonly string[]): InputBox {
  const box = createInputBox({ history: () => history });
  for (const key of keys) box.press(key);
  return box;
}

/** Kills until the box shows no text, as the driver does; gives how many kills it took. */
function killUntilEmpty(box: InputBox): number {
  let kills = 0;
  do {
    box.press(kill);
    kills += 1;
  } while (!box.drawn().looksEmpty && kills < 500);
  return kills;
}

function repeated(key: Key, times: number): Key[] {
  return Array.from({ length: times }, () => key);
}

describe("the fake agent's input box: how it wraps", () => {
  it('wraps a line of words at 116 columns: a word that does not fit begins the next row; after a full row, so does the blank', () => {
    const rows = layOut(LONG_LINE, 116);

    expect(rows.map((row) => row.shown.trimEnd().split(' ').length)).toEqual([
      13, 12, 13, 12, 13, 7,
    ]);
    expect(rows[0]?.shown).toBe(LONG_LINE.slice(0, 116));
    expect(rows[1]?.shown).toMatch(/^word013x/);
  });

  it('fills the row a word wider than one begins on, then goes on over the next rows', () => {
    const shown = layOut(draftLines(1, 280), 116).map((row) => row.shown);

    expect(shown.map((row) => row.length)).toEqual([116, 116, 62]);
    expect(shown[0]).toMatch(/^draft line 01 abcdefghij/);
  });

  it('leaves the blank where a row wraps at the end of the row, undrawn: the cursor after it is on a row of its own', () => {
    const rows = layOut(`${'x'.repeat(116)} `, 116);

    expect(rows.map((row) => row.shown)).toEqual(['x'.repeat(116), '']);
    expect(layOut(`${'x'.repeat(115)} `, 116).map((row) => row.shown)).toEqual([
      `${'x'.repeat(115)} `,
    ]);
  });

  it('draws the invisible separator nowhere, in no cell', () => {
    expect(layOut(`${'x'.repeat(116)}${SEPARATOR}`, 116).map((row) => row.shown)).toEqual([
      'x'.repeat(116),
    ]);
  });

  it('refuses what it was not seen to draw: a character of another script, a row that would begin with two blanks', () => {
    expect(() => layOut('漢字', 116)).toThrow(/U\+6F22 .* not observed/);
    expect(() => layOut(`${'x'.repeat(116)}  y`, 116)).toThrow(/two blanks/);
  });
});

describe("the fake agent's input box: the keys the driver types a prompt with", () => {
  it('Ctrl+U kills one screen row of a wrapped line: six kills for six rows, one yank brings it all back', () => {
    const box = boxAfter([text(LONG_LINE), text(SEPARATOR)]);

    expect(killUntilEmpty(box)).toBe(6);
    box.press(yank);
    box.press(backspace);
    expect(box.text()).toBe(LONG_LINE);
  });

  it('after a kill that leaves a blank at the end of a full row, the box shows an empty row', () => {
    const box = boxAfter([text(LONG_LINE), kill]);

    expect(box.drawn().rows).toHaveLength(6);
    expect(box.drawn().rows.at(-1)).toBe('  ');
  });

  it('kills a line, then the line break before it: two kills a line, less one', () => {
    const box = boxAfter([...typing(draftLines(25)), text(SEPARATOR)]);

    expect(killUntilEmpty(box)).toBe(49);
    box.press(yank);
    box.press(backspace);
    expect(box.text()).toBe(draftLines(25));
  });

  it('kills the rows of lines that each wrap: fifteen rows and four line breaks', () => {
    const box = boxAfter([...typing(draftLines(5, 280)), text(SEPARATOR)]);

    expect(killUntilEmpty(box)).toBe(19);
  });

  it('Ctrl+E goes to the end of the line, not of the row the cursor is on', () => {
    const box = boxAfter([text(LONG_LINE.slice(0, 260)), up, endOfLine, text('E')]);

    expect(box.text()).toBe(`${LONG_LINE.slice(0, 260)}E`);
  });

  it('Down moves a row at a time, to the last row and no further', () => {
    const box = boxAfter([...typing(draftLines(3)), up, up, ...repeated(down, 5), text('!')]);

    expect(box.text()).toBe(`${draftLines(3)}!`);
    expect(box.downLeavesTheBox()).toBe(true);
  });

  it('a kill after another key starts a new piece; a kill of nothing keeps the piece going', () => {
    const box = boxAfter([text('old'), kill, kill, text(SEPARATOR), yank, backspace]);

    expect(box.text()).toBe(`${SEPARATOR}ol`);
  });
});

describe("the fake agent's input box: what it shows", () => {
  it('shows the rows around the cursor when it is taller than 15, and says on its rules how many it hides', () => {
    const box = boxAfter(typing(draftLines(25)));

    expect(box.drawn()).toMatchObject({ above: '↑ 10 more', below: undefined });
    expect(box.drawn().rows[0]).toBe('  draft line 11');
    for (const key of repeated(up, 10)) box.press(key);
    expect(box.drawn()).toMatchObject({ above: '↑ 7 more', below: '↓ 3 more' });
    expect(box.drawn().rows.at(7)).toBe('  draft line 15');
  });

  it('draws the sign on the box first row only', () => {
    expect(boxAfter(typing('one\ntwo')).drawn().rows).toEqual(['❯\u00a0one', '  two']);
  });

  it('refuses a box of several rows in a terminal of a size it was not seen at', () => {
    const box = createInputBox({ size: () => ({ columns: 100, rows: 30 }) });
    box.press(text('one line'));

    expect(() => box.press(lineBreak)).toThrow(/100×30/);
  });
});

describe("the fake agent's input box: shell mode", () => {
  it('turns on at a ! typed into an empty box, which it does not hold', () => {
    const box = boxAfter([text('!ls')]);

    expect(box.inShellMode()).toBe(true);
    expect(box.text()).toBe('ls');
    expect(box.drawn().rows).toEqual(['!\u00a0ls']);
  });

  it('is left by Backspace or Ctrl+U on the empty box; the kill ring is kept', () => {
    expect(boxAfter([text('!'), backspace]).inShellMode()).toBe(false);
    const box = boxAfter([text('!ls'), kill, kill]);

    expect(box.inShellMode()).toBe(false);
    box.press(text('!'));
    box.press(yank);
    expect(box.drawn().rows).toEqual(['!\u00a0ls']);
  });

  it('a ! typed into a box with text is text', () => {
    expect(boxAfter([text('a!')]).inShellMode()).toBe(false);
  });
});

describe("the fake agent's input box: the history of prompts", () => {
  const history = ['launch prompt', 'typed prompt', 'm1\nm2\nm3'];

  it('Up from the first row shows the newest prompt, its rule saying so; Up again an older one, down to the oldest', () => {
    const box = boxAfter([text('dr'), up], history);

    expect(box.drawn()).toMatchObject({
      above: 'History 3/3',
      rows: ['❯\u00a0m1', '  m2', '  m3'],
    });
    for (const key of [up, up, up]) box.press(key);
    expect(box.drawn()).toMatchObject({ above: 'History 2/3', rows: ['❯\u00a0typed prompt'] });
    box.press(up);
    box.press(up);
    expect(box.drawn()).toMatchObject({ above: 'History 1/3', rows: ['❯\u00a0launch prompt'] });
  });

  it('Down shows a newer prompt with the cursor at its start, then the draft, the cursor at its start', () => {
    const box = boxAfter([...typing('l1\nl2'), up, up, up, up, up], history);

    expect(box.drawn()).toMatchObject({ above: 'History 2/3' });
    for (const key of [down, down, down, down]) box.press(key);
    expect(box.drawn()).toMatchObject({ above: undefined, rows: ['❯\u00a0l1', '  l2'] });
    box.press(text('X'));
    expect(box.text()).toBe('Xl1\nl2');
  });

  it('an entry edited loses its rule, and is lost on Down', () => {
    const past = ['past prompt one', 'past prompt two'];
    const box = boxAfter([text('my own draft'), up, up, up, endOfLine, text(' EDITED')], past);

    expect(box.drawn()).toMatchObject({
      above: undefined,
      rows: ['❯\u00a0past prompt one EDITED'],
    });
    box.press(down);
    expect(box.drawn()).toMatchObject({ above: 'History 2/2', rows: ['❯\u00a0past prompt two'] });
    box.press(down);
    expect(box.text()).toBe('my own draft');
  });

  it('Up with no prompt taken yet does nothing', () => {
    expect(boxAfter([text('a'), up], []).drawn()).toMatchObject({
      above: undefined,
      rows: ['❯\u00a0a'],
    });
  });

  it('refuses Up into a history it does not know', () => {
    expect(() => boxAfter([up], undefined)).toThrow(/history/);
  });
});
