import type { InputBox, ScreenReading } from '../server/driver.js';
import type { StartupDialog } from '../shared/session.js';

/**
 * Each start-up dialog Claude Code (2.1.332) draws, by words that all show
 * while it waits: words of its question and of the option that goes on,
 * which nothing else on a start-up screen holds together. Matched with
 * every run of blanks as one space, so that a narrower terminal, where the
 * agent wraps its sentences, reads the same.
 */
const DIALOGS: readonly { readonly dialog: StartupDialog; readonly words: readonly string[] }[] = [
  { dialog: 'trust-folder', words: ['Accessing workspace:', 'Yes, I trust this folder'] },
  {
    dialog: 'bypass-permissions',
    words: ['running in Bypass Permissions mode', 'Yes, I accept'],
  },
  { dialog: 'login', words: ['Select login method:'] },
  // The first run: the theme picker, then the security notes.
  { dialog: 'onboarding', words: ['Choose the text style that looks best with your terminal'] },
  { dialog: 'onboarding', words: ['Security notes:', 'Press Enter to continue'] },
];

/**
 * The hints of a panel that only a key in the terminal closes: a choice to
 * confirm (the custom API-key question, among the dialogs with no name) or
 * a panel to leave (`/help`'s).
 */
const PANEL_HINTS: readonly string[] = ['Enter to confirm · Esc to cancel', 'Esc to close'];

/** The footer's hint while the agent works on a turn: the box is drawn, but takes no prompt. */
const WORKING_HINT = 'esc to interrupt';

/**
 * Reads Claude Code's screen while the cockpit waits for a signal no hook
 * gives: the input box ready for a prompt, a start-up dialog by its name, a
 * panel that waits for a key with no name, or nothing it can tell.
 *
 * The input box is read first: it is drawn only once every dialog is
 * answered, and the conversation above it may quote any dialog's words.
 *
 * @param text - The screen, row by row.
 * @returns What it shows.
 */
export function readScreen(text: string): ScreenReading {
  const rows = text.split('\n');
  const footer = footerOfInputBox(rows);
  if (footer !== undefined) {
    return footer.includes(WORKING_HINT) ? { shows: 'nothing' } : { shows: 'ready' };
  }
  const words = text.replace(/\s+/g, ' ');
  const known = DIALOGS.find((dialog) => dialog.words.every((word) => words.includes(word)));
  if (known) return { shows: 'dialog', dialog: known.dialog };
  if (PANEL_HINTS.some((hint) => words.includes(hint))) return { shows: 'dialog' };
  return { shows: 'nothing' };
}

/**
 * The rows below the input box, the footer, joined; `undefined` when the
 * screen shows no input box.
 */
function footerOfInputBox(rows: readonly string[]): string | undefined {
  const box = readBoxRows(rows);
  return box === undefined ? undefined : rows.slice(box.lastRow + 2).join('\n');
}

/**
 * The input box as the driver reads it while it types a prompt: what it
 * holds, where it is on the screen, and how it is drawn.
 */
export interface InputBoxView {
  /**
   * The text of its visible rows, joined by `\n`, the sign's column left
   * out: a line wider than the box shows on several rows.
   */
  readonly text: string;
  /**
   * The sign before its first line: `❯`, or `!` in shell mode; `undefined`
   * when the first line is scrolled out of the box.
   */
  readonly sign: '❯' | '!' | undefined;
  /** The screen rows of its first and its last visible row, counted from 0. */
  readonly firstRow: number;
  /** See {@link InputBoxView.firstRow}. */
  readonly lastRow: number;
  /** The rows scrolled out of the box above its window (`↑ N more`). */
  readonly hiddenAbove: number;
  /** The rows scrolled out of the box below its window (`↓ N more`). */
  readonly hiddenBelow: number;
  /** Whether it shows an entry recalled from the prompt history (`History n/m`). */
  readonly recalled: boolean;
}

/**
 * A rule above or below the input box: a line, with a label in it when the
 * box scrolls (`─── ↑ 7 more ───`) or shows the history (`─── History 2/2 ───`).
 */
const RULE = /^─{3,}(?: [^─]+ ─+)*$/;

/**
 * The sign the first line starts with, then the no-break space Claude Code
 * draws after it (a plain space, or nothing, where a copy of the screen
 * dropped or replaced it).
 */
const SIGNED_ROW = /^([❯!])(?:[\u00a0 ]|$)/;

/** What starts every other row: the sign's column, blank. */
const SIGN_COLUMN = '  ';

/**
 * Reads Claude Code's input box from its screen: the rows between the last
 * two rules, each in the box's own shape — the first with its sign (unless
 * scrolled out), the others indented by the sign's column. A dialog drawn
 * between two rules has neither, so it reads as no box.
 *
 * @param text - The screen, row by row.
 * @returns The box; `undefined` when the screen shows none.
 */
export function readInputBoxView(text: string): InputBoxView | undefined {
  return readBoxRows(text.split('\n'));
}

function readBoxRows(rows: readonly string[]): InputBoxView | undefined {
  const rules = rows.flatMap((row, index) => (RULE.test(row.trimEnd()) ? [index] : []));
  const [opening, closing] = rules.slice(-2);
  if (opening === undefined || closing === undefined || closing === opening + 1) return undefined;
  const top = rows[opening] ?? '';
  const bottom = rows[closing] ?? '';
  const hiddenAbove = hiddenIn(top, '↑');
  const body = rows.slice(opening + 1, closing);
  const [first = '', ...others] = body;
  const sign = SIGNED_ROW.exec(first)?.[1] as '❯' | '!' | undefined;
  if (sign === undefined && !(hiddenAbove > 0 && isIndented(first))) return undefined;
  if (!others.every(isIndented)) return undefined;
  return {
    text: body.map((row) => row.slice(SIGN_COLUMN.length)).join('\n'),
    sign,
    firstRow: opening + 1,
    lastRow: closing - 1,
    hiddenAbove,
    hiddenBelow: hiddenIn(bottom, '↓'),
    recalled: /─ History \d+\/\d+ ─/.test(top),
  };
}

function isIndented(row: string): boolean {
  return row === '' || row.startsWith(SIGN_COLUMN);
}

function hiddenIn(rule: string, arrow: '↑' | '↓'): number {
  const count = new RegExp(`─ ${arrow} (\\d+) more ─`).exec(rule)?.[1];
  return count === undefined ? 0 : Number(count);
}

/**
 * Tells whether an input box holds nothing, scrolled out of it either.
 *
 * @param box - The box.
 */
export function isEmptyBox(box: InputBoxView): boolean {
  return box.text === '' && box.hiddenAbove === 0 && box.hiddenBelow === 0;
}

/**
 * Reads Claude Code's input box from its screen, while a prompt is typed:
 * the core checks it before every write. An entry the person recalled from
 * the history is no box to type into: typed over, an edit they made to it
 * would be lost.
 *
 * @param text - The screen, row by row.
 * @returns The box and its visible text; `undefined` when the screen shows
 * none, or a recalled entry in it.
 */
export function readInputBox(text: string): InputBox | undefined {
  const box = readInputBoxView(text);
  return box === undefined || box.recalled ? undefined : { text: box.text };
}
