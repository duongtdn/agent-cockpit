import {
  type BoxRow,
  cellsOf,
  INVISIBLE_SEPARATOR,
  layOut,
  OBSERVED_SIZE,
  rowOf,
  type TerminalSize,
  textWidthIn,
  windowOf,
} from './box-layout.ts';
import type { Key } from './keys.ts';

/** The box as the screen draws it. */
export interface DrawnBox {
  /** The rows shown, each with what begins it: the sign on the box's first row, two blanks on the others. */
  readonly rows: readonly string[];
  /** What the rule above the box says: the history entry shown, or the rows hidden above; none on a plain rule. */
  readonly above: string | undefined;
  /** What the rule below the box says: the rows hidden below; none on a plain rule. */
  readonly below: string | undefined;
  /** Whether the box shows no text: the invisible separator alone shows none. */
  readonly looksEmpty: boolean;
  /** Whether the box is in shell mode, its sign `!`. */
  readonly inShellMode: boolean;
  /**
   * Where the cursor is drawn, among the rows shown and the columns of the
   * terminal: Claude Code puts the terminal's cursor there.
   */
  readonly cursor: { readonly row: number; readonly column: number };
}

/**
 * Where typed text waits until Enter submits it, with the editing Claude
 * Code 2.1.332 was seen to do in it: a cursor that Up and Down move a
 * screen row at a time, Ctrl+E to the end of the line, Ctrl+U killing back
 * to the start of the cursor's screen row (or the line break before it),
 * Ctrl+Y yanking what successive kills killed and Alt+Y right after it
 * the kill before, the history of the prompts
 * on Up from the first row, and shell mode on a `!` typed into an empty box.
 */
export interface InputBox {
  /** Gives the text in the box, its lines joined by line breaks. */
  text(): string;
  /**
   * Applies a key: the editing keys change the text, the others do nothing.
   *
   * @throws `Error` for what was not observed: see {@link layOut} and
   * {@link windowOf}, and the history where it is not known.
   */
  press(key: Key): void;
  /**
   * Empties the box, and leaves the history.
   *
   * @returns The text it held.
   */
  take(): string;
  /** Puts a text back into the box, at its end, the cursor after it. */
  putBack(text: string): void;
  /** Tells whether the box is in shell mode, where Enter runs a command. */
  inShellMode(): boolean;
  /**
   * Tells whether Down would leave the box: the cursor on its last row,
   * no history entry shown. Where a background task runs, Claude Code then
   * moves to its footer.
   */
  downLeavesTheBox(): boolean;
  /**
   * Draws the box.
   *
   * @throws `Error` as {@link InputBox.press}.
   */
  drawn(): DrawnBox;
}

/** What an input box needs to know of its session. */
export interface InputBoxSurroundings {
  /** The terminal's size now. */
  readonly size?: () => TerminalSize;
  /**
   * The prompts Up shows, oldest first; `undefined` when what Claude Code
   * would show is not known: Up into the history is then not played.
   */
  readonly history?: () => readonly string[] | undefined;
}

const SHELL_SIGN = '!';
/** The cells the sign and the blank after it take, before every row's text. */
const SIGN_CELLS = 2;
const PROMPT_SIGN = '❯';

/** What the box held before the history was browsed, which Down past the newest entry brings back. */
interface Browsing {
  index: number;
  readonly draft: readonly string[];
}

/**
 * Creates an input box.
 *
 * @param surroundings - See {@link InputBoxSurroundings}; the observed size and no history by default.
 * @returns The box, empty, with nothing killed.
 */
export function createInputBox(surroundings: InputBoxSurroundings = {}): InputBox {
  const size = surroundings.size ?? (() => OBSERVED_SIZE);
  const history = surroundings.history ?? (() => []);
  let text: string[] = [];
  let cursor = 0;
  let shell = false;
  /** The kill ring, oldest first: successive kills make one entry. */
  const killRing: string[] = [];
  let lastKeyKilled = false;
  /** The text the last key yanked, and its entry of the kill ring: Alt+Y replaces it with the one before. */
  let yanked: { readonly start: number; readonly index: number } | undefined;
  let lastKeyYanked = false;
  let browsing: Browsing | undefined;

  const rows = (): BoxRow[] => layOut(text.join(''), textWidthIn(size()));

  function insert(inserted: string): void {
    const characters = Array.from(inserted);
    text.splice(cursor, 0, ...characters);
    cursor += characters.length;
  }

  function remove(from: number, to: number): string {
    const removed = text.splice(from, to - from).join('');
    cursor = from;
    return removed;
  }

  function type(typed: string): void {
    for (const character of typed) {
      if (character === SHELL_SIGN && text.length === 0 && !shell) shell = true;
      else insert(character);
    }
  }

  /** On an empty box in shell mode, Backspace and Ctrl+U leave shell mode; the kill ring is kept. */
  function leavesShellMode(): boolean {
    if (!shell || text.length > 0) return false;
    shell = false;
    return true;
  }

  function killToRowStart(): void {
    if (leavesShellMode()) return;
    const laidOut = rows();
    const index = rowOf(laidOut, cursor);
    const row = laidOut[index] as BoxRow;
    let from = row.start;
    if (cursor === row.start) {
      if (cursor === 0) from = 0;
      else if (row.beginsLine) from = cursor - 1;
      else from = (laidOut[index - 1] as BoxRow).start;
    }
    const removed = remove(from, cursor);
    if (lastKeyKilled && killRing.length > 0) {
      killRing[killRing.length - 1] = removed + killRing.at(-1);
    } else if (removed !== '') {
      killRing.push(removed);
    }
  }

  function yank(): void {
    const index = killRing.length - 1;
    yanked = undefined;
    if (index < 0) return;
    yanked = { start: cursor, index };
    insert(killRing[index] as string);
  }

  /**
   * Seen of Claude Code: Alt+Y right after Ctrl+Y puts the kill ring's entry
   * before the one yanked in its place.
   *
   * @throws `Error` for Alt+Y after any other key, or past the oldest
   * entry: neither was observed.
   */
  function yankEarlier(): void {
    if (!lastKeyYanked || yanked === undefined) {
      throw new Error('Alt+Y after another key than Ctrl+Y or Alt+Y: not observed');
    }
    if (yanked.index === 0)
      throw new Error("Alt+Y past the kill ring's oldest entry: not observed");
    const index = yanked.index - 1;
    remove(yanked.start, cursor);
    yanked = { start: cursor, index };
    insert(killRing[index] as string);
  }

  function endOfLine(): void {
    const nextBreak = text.indexOf('\n', cursor);
    cursor = nextBreak === -1 ? text.length : nextBreak;
  }

  /** Moves the cursor to another row, as far along it as it was, or to the row's last place. */
  function moveToRow(laidOut: readonly BoxRow[], from: number, to: number): void {
    const column = cursor - (laidOut[from] as BoxRow).start;
    const target = laidOut[to] as BoxRow;
    // Where a wrapped line goes on, the row's end is the next row's start.
    const endsLine = laidOut[to + 1]?.beginsLine ?? true;
    const last = endsLine ? target.end : target.end - 1;
    cursor = Math.min(target.start + column, last);
  }

  function up(): void {
    const laidOut = rows();
    const index = rowOf(laidOut, cursor);
    if (index > 0) moveToRow(laidOut, index, index - 1);
    else older();
  }

  function down(): void {
    const laidOut = rows();
    const index = rowOf(laidOut, cursor);
    if (index < laidOut.length - 1) moveToRow(laidOut, index, index + 1);
    else if (browsing !== undefined) newer(browsing);
  }

  function knownHistory(): readonly string[] {
    if (shell) throw new Error('Up into the history in shell mode: not observed');
    const entries = history();
    if (entries === undefined) {
      throw new Error(
        'Up into the history of a session that did not take all its prompts itself: what Claude Code shows then was not observed',
      );
    }
    return entries;
  }

  /** Seen of Claude Code: an older entry shows with the cursor at its end; the oldest stays. */
  function older(): void {
    const entries = knownHistory();
    if (browsing === undefined) {
      if (entries.length === 0) return;
      browsing = { index: entries.length, draft: [...text] };
    }
    if (browsing.index === 0) return;
    browsing.index -= 1;
    show(entries[browsing.index] as string, 'at-end');
  }

  /** Seen of Claude Code: a newer entry, and the draft past the newest, show with the cursor at their start. */
  function newer(shown: Browsing): void {
    const entries = knownHistory();
    shown.index += 1;
    if (shown.index < entries.length) {
      show(entries[shown.index] as string, 'at-start');
    } else {
      text = [...shown.draft];
      cursor = 0;
      browsing = undefined;
    }
  }

  function show(entry: string, cursorAt: 'at-start' | 'at-end'): void {
    text = Array.from(entry);
    cursor = cursorAt === 'at-start' ? 0 : text.length;
  }

  function backspace(): void {
    if (!leavesShellMode() && cursor > 0) remove(cursor - 1, cursor);
  }

  /** What each editing key does; the other keys do nothing here. */
  const editing: Partial<Record<Key['kind'], (key: Key) => void>> = {
    text: (key) => type((key as { readonly text: string }).text),
    'line-break': () => insert('\n'),
    backspace,
    'kill-line': killToRowStart,
    yank,
    'yank-pop': yankEarlier,
    'end-of-line': endOfLine,
    up,
    down,
  };

  function apply(key: Key): void {
    editing[key.kind]?.(key);
  }

  function drawn(): DrawnBox {
    const laidOut = rows();
    const cursorRow = rowOf(laidOut, cursor);
    const window = windowOf(laidOut.length, cursorRow, size());
    const shownRows = laidOut
      .slice(window.first, window.first + window.count)
      .map((row, index) => `${window.first + index === 0 ? `${sign()}\u00a0` : '  '}${row.shown}`);
    return {
      rows: shownRows,
      above: aboveLabel(window.hiddenAbove),
      below: window.hiddenBelow > 0 ? `↓ ${window.hiddenBelow} more` : undefined,
      looksEmpty: text.every((character) => character === INVISIBLE_SEPARATOR),
      inShellMode: shell,
      cursor: {
        row: cursorRow - window.first,
        column: SIGN_CELLS + cellsBefore(laidOut[cursorRow] as BoxRow),
      },
    };
  }

  /** The cells between the start of the cursor's row and the cursor. */
  function cellsBefore(row: BoxRow): number {
    return text
      .slice(row.start, cursor)
      .reduce((cells, character) => cells + cellsOf(character), 0);
  }

  function sign(): string {
    return shell ? SHELL_SIGN : PROMPT_SIGN;
  }

  /** Seen of Claude Code: the rule names the entry shown until it is edited. */
  function aboveLabel(hiddenAbove: number): string | undefined {
    const entries = browsing === undefined ? undefined : history();
    const entry = browsing === undefined ? undefined : entries?.[browsing.index];
    const showsEntry = entry !== undefined && entry === text.join('');
    if (showsEntry && hiddenAbove > 0) {
      throw new Error(
        'a history entry taller than the input box: how its rule reads was not observed',
      );
    }
    if (showsEntry) return `History ${(browsing as Browsing).index + 1}/${entries?.length}`;
    return hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : undefined;
  }

  return {
    text: () => text.join(''),
    press(key) {
      apply(key);
      lastKeyKilled = key.kind === 'kill-line';
      lastKeyYanked = key.kind === 'yank' || key.kind === 'yank-pop';
      drawn();
    },
    take() {
      const taken = text.join('');
      text = [];
      cursor = 0;
      browsing = undefined;
      return taken;
    },
    putBack(returned) {
      cursor = text.length;
      insert(returned);
    },
    inShellMode: () => shell,
    downLeavesTheBox() {
      const laidOut = rows();
      return browsing === undefined && rowOf(laidOut, cursor) === laidOut.length - 1;
    },
    drawn,
  };
}
