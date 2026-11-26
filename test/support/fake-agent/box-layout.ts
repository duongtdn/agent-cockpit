/** A terminal's size, in cells. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * The one size Claude Code's input box was seen at: there its text wraps at
 * 116 columns (the sign and its blank take two, the margin two more) and
 * the box shows 15 rows at most. At any other size a box of one row is
 * drawn alike; a taller one is not played.
 */
export const OBSERVED_SIZE: TerminalSize = { columns: 120, rows: 40 };

const OBSERVED_TEXT_WIDTH = 116;
const OBSERVED_HEIGHT = 15;

/** The character the driver marks the end of a draft with: inserted, never drawn. */
export const INVISIBLE_SEPARATOR = '⁣';

/** One row of the box: the text of a logical line between two offsets, in code points. */
export interface BoxRow {
  /** Where the row begins in the box's text. */
  readonly start: number;
  /** Where the next row begins, or the line ends: a blank at a wrap is the row's, undrawn. */
  readonly end: number;
  /** What the row shows. */
  readonly shown: string;
  /** Whether the row begins a line of the text, rather than going on with a wrapped one. */
  readonly beginsLine: boolean;
}

/** The rows of the box a window shows, and how many it hides above and below. */
export interface BoxWindow {
  readonly first: number;
  readonly count: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/**
 * Tells how wide a character is drawn. Only the characters seen in the box
 * are played: the invisible separator takes no cell, Latin letters (those of
 * Vietnamese too, composed) one each.
 *
 * @throws `Error` for any other character: how wide Claude Code draws it, and
 * where it wraps around it, was not observed.
 */
export function cellsOf(character: string): number {
  if (character === INVISIBLE_SEPARATOR) return 0;
  const code = character.codePointAt(0) ?? 0;
  const latin =
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0x24f) ||
    (code >= 0x1e00 && code <= 0x1eff);
  if (latin) return 1;
  throw new Error(
    `the character U+${code.toString(16).toUpperCase().padStart(4, '0')} in the input box: how Claude Code draws it was not observed`,
  );
}

/** What characters look like on screen: the invisible separator is never drawn. */
function drawnOf(characters: readonly string[]): string {
  return characters.filter((character) => character !== INVISIBLE_SEPARATOR).join('');
}

function widthOf(characters: readonly string[]): number {
  return characters.reduce((sum, character) => sum + cellsOf(character), 0);
}

/**
 * Gives how wide the box's text may be in a terminal.
 *
 * @returns The columns of text a row holds.
 */
export function textWidthIn(size: TerminalSize): number {
  return isObserved(size) ? OBSERVED_TEXT_WIDTH : size.columns - 4;
}

function isObserved(size: TerminalSize): boolean {
  return size.columns === OBSERVED_SIZE.columns && size.rows === OBSERVED_SIZE.rows;
}

/**
 * Lays the box's text out in rows, as Claude Code 2.1.332 was seen to wrap
 * it — the way `wrap-ansi` wraps with `hard` on and `trim` off: each line on
 * rows of its own; a word that does not fit after the others begins the
 * next row, the blank before it left at the end of the row, undrawn; but
 * where a row is full to its last column, that blank begins the next row,
 * takes a cell there and is not drawn either (the rows of the spike's long
 * line hold 13, 12, 13, 12… words); a word wider than a row fills rows from
 * the one it begins on, unless it would need fewer from the next.
 *
 * @param text - The box's text, its lines joined by line breaks.
 * @param width - The columns of text a row holds.
 * @returns The rows, top to bottom: one at least.
 * @throws `Error` for what was not observed: a character {@link cellsOf}
 * refuses, and a row that would begin with two blanks.
 */
export function layOut(text: string, width: number): BoxRow[] {
  const characters = Array.from(text);
  const rows: BoxRow[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const length = Array.from(line).length;
    rows.push(...layOutLine(characters.slice(lineStart, lineStart + length), lineStart, width));
    lineStart += length + 1;
  }
  return rows;
}

/** A row being filled: where it begins, and its characters, a blank that begins it included. */
interface OpenRow {
  readonly start: number;
  readonly characters: string[];
}

function layOutLine(line: readonly string[], offset: number, width: number): BoxRow[] {
  const rows: OpenRow[] = [{ start: offset, characters: [] }];
  const last = (): OpenRow => rows.at(-1) as OpenRow;
  const begin = (start: number): void => void rows.push({ start, characters: [] });
  const words = splitWords(line, offset);
  for (const [index, word] of words.entries()) {
    const cells = widthOf(word.characters);
    if (index > 0) {
      if (widthOf(last().characters) >= width) begin(word.start - 1);
      last().characters.push(' ');
    }
    const used = widthOf(last().characters);
    if (cells > width) {
      if (wouldNeedFewerRowsFromTheNext(cells, width - used, width)) begin(word.start);
      fillRows(word, width, rows);
    } else {
      if (used + cells > width && used > 0 && cells > 0) begin(word.start);
      last().characters.push(...word.characters);
    }
  }
  return rows.map((row, index) =>
    boxRow(row, rows[index + 1]?.start ?? offset + line.length, index === 0),
  );
}

/** A row as the box keeps it: the blank a wrap began it with is not drawn, and the cursor never stands before it. */
function boxRow(row: OpenRow, end: number, beginsLine: boolean): BoxRow {
  const leadingBlanks = beginsLine ? 0 : row.characters.findIndex((character) => character !== ' ');
  const blanks = leadingBlanks === -1 ? row.characters.length : leadingBlanks;
  if (blanks > 1)
    throw new Error('a row of the input box that begins with two blanks: not observed');
  return {
    start: row.start + blanks,
    end,
    shown: drawnOf(row.characters.slice(blanks)),
    beginsLine,
  };
}

/** A word of a line, between blanks, and where it begins in the text. */
interface Word {
  readonly characters: readonly string[];
  readonly start: number;
}

function splitWords(line: readonly string[], offset: number): Word[] {
  const words: Word[] = [];
  let start = 0;
  for (let index = 0; index <= line.length; index += 1) {
    if (index === line.length || line[index] === ' ') {
      words.push({ characters: line.slice(start, index), start: offset + start });
      start = index + 1;
    }
  }
  return words;
}

function wouldNeedFewerRowsFromTheNext(cells: number, left: number, width: number): boolean {
  const fromHere = 1 + Math.floor((cells - left - 1) / width);
  const fromTheNext = Math.floor((cells - 1) / width);
  return fromTheNext < fromHere;
}

/** Fills rows with a word wider than one, from the last row; a row filled to its last column ends there. */
function fillRows(word: Word, width: number, rows: OpenRow[]): void {
  let used = widthOf((rows.at(-1) as OpenRow).characters);
  for (const [index, character] of word.characters.entries()) {
    const cells = cellsOf(character);
    if (used + cells > width) {
      rows.push({ start: word.start + index, characters: [] });
      used = 0;
    }
    (rows.at(-1) as OpenRow).characters.push(character);
    used += cells;
    if (used === width && index < word.characters.length - 1) {
      rows.push({ start: word.start + index + 1, characters: [] });
      used = 0;
    }
  }
}

/**
 * Gives the row a cursor is on: the last that begins at or before it. A
 * cursor where a wrapped line goes on is at the start of the next row.
 *
 * @param rows - The box's rows.
 * @param cursor - The cursor's offset, in code points.
 */
export function rowOf(rows: readonly BoxRow[], cursor: number): number {
  return rows.findLastIndex((row) => row.start <= cursor);
}

/**
 * Gives the rows a box shows in a terminal: all of them when they fit,
 * else as many as fit with the cursor's row in their middle, as Claude Code
 * was seen to scroll its box (the spike's 25 and 60 lines).
 *
 * @param rowCount - The box's rows.
 * @param cursorRow - The row the cursor is on.
 * @param size - The terminal's size.
 * @throws `Error` for a box of several rows in a terminal of another size
 * than {@link OBSERVED_SIZE}: where it wraps and how tall it grows there
 * was not observed.
 */
export function windowOf(rowCount: number, cursorRow: number, size: TerminalSize): BoxWindow {
  if (rowCount > 1 && !isObserved(size)) {
    throw new Error(
      `an input box of ${rowCount} rows in a terminal of ${size.columns}×${size.rows}: Claude Code's box was observed at ${OBSERVED_SIZE.columns}×${OBSERVED_SIZE.rows} only`,
    );
  }
  const count = Math.min(rowCount, OBSERVED_HEIGHT);
  const centered = cursorRow - Math.floor(count / 2);
  const first = Math.max(0, Math.min(centered, rowCount - count));
  return { first, count, hiddenAbove: first, hiddenBelow: rowCount - first - count };
}
