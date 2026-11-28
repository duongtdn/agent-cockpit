import type { InputBox, ScreenReading, ScreenStateSigns } from '../server/driver.js';
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
 * Each panel Claude Code (2.1.332) draws in place of its input box when a
 * local command opens it, by words that all show while it waits for a key:
 * its tabs or its title, and what it shows or its hint. `/cost`, `/status`
 * and `/config` open the same tabbed panel, each on its own tab, named here
 * by the tab shown.
 */
const PANELS: readonly { readonly panel: string; readonly words: readonly string[] }[] = [
  { panel: 'help', words: ['Help General Commands Custom commands', 'Esc to close'] },
  { panel: 'cost', words: ['Settings Status Config Usage Stats', 'Estimated cost:'] },
  { panel: 'status', words: ['Settings Status Config Usage Stats', 'Session ID:'] },
  { panel: 'config', words: ['Settings Status Config Usage Stats', '⌕'] },
  { panel: 'model', words: ['Select model', 'Enter to save · Esc to cancel'] },
];

/**
 * The hints of a dialog or a panel that only a key in the terminal closes,
 * when nothing else on screen names it: a choice to confirm (the custom
 * API-key question, among the dialogs with no name) or a panel to leave.
 */
const UNNAMED_HINTS: readonly string[] = ['Enter to confirm · Esc to cancel', 'Esc to close'];

/**
 * The footer's hint while the agent works on a turn or a compaction: drawn
 * over an empty box only; over a draft the footer is the mode's hint
 * alone, as when the agent is idle.
 */
const WORKING_HINT = 'esc to interrupt';

/**
 * The spinner's row, which Claude Code draws above the input box while it
 * works on a turn or a compaction, a draft in the box or none: a sign, a
 * verb that ends in `…`, then what it waits for in brackets
 * (`✶ Wrangling… (running Stop hook · 2s)`, `* Compacting conversation…`).
 * It is the last row of the conversation above the box: the rows between
 * them are indented (a tip, the effort's level). The conversation's own
 * rows start with signs of their own (`●` an answer, `❯` a prompt, `!` a
 * shell command), which may end in `…` too; a turn's last row, once it is
 * done, has no `…` (`✻ Worked for 4s · done 9:55 AM`). Any other sign
 * reads as the spinner's: a busy agent is never taken for a ready one.
 */
const SPINNER_ROW = /^[^\s●❯!] \S[^…]*…/u;

/**
 * Reads Claude Code's screen for where to type and what waits for a person:
 * the input box free to type into, a start-up dialog by its name, a panel
 * by its name, a dialog or panel with no name, a screen it does not know, or
 * nothing it can tell.
 *
 * The input box is read first: it is drawn only once every dialog is
 * answered, and the conversation above it may quote any dialog's words.
 * The box is free unless the agent works: the spinner's row above it, or
 * the footer's hint below it, shows that.
 *
 * @param text - The screen, row by row.
 * @returns What it shows.
 */
export function readScreen(text: string): ScreenReading {
  const rows = text.split('\n');
  const box = readBoxRows(rows);
  if (box !== undefined) return isWorking(rows, box) ? NOTHING : { shows: 'input-box' };
  const words = text.replace(/\s+/g, ' ');
  const showsAll = (all: readonly string[]) => all.every((word) => words.includes(word));
  const dialog = DIALOGS.find((known) => showsAll(known.words));
  if (dialog) return { shows: 'dialog', dialog: dialog.dialog };
  const panel = PANELS.find((known) => showsAll(known.words));
  if (panel) return { shows: 'panel', panel: panel.panel };
  if (UNNAMED_HINTS.some((hint) => words.includes(hint))) return { shows: 'dialog' };
  return words.trim() === '' ? NOTHING : { shows: 'unknown' };
}

const NOTHING: ScreenReading = { shows: 'nothing' };

/**
 * The places Claude Code's screen tells its state where nothing else does,
 * each read from the spinner's row alone (never the footer's hint, which a
 * draft in the box changes).
 */
export const SCREEN_STATE_SIGNS: ScreenStateSigns = {
  launchPanelClosed(text) {
    const rows = text.split('\n');
    const box = readBoxRows(rows);
    return box !== undefined && !showsSpinner(rows, box);
  },
  promptWithdrawn(text, prompt) {
    const rows = text.split('\n');
    const box = readBoxRows(rows);
    // A withdrawn prompt is never in shell mode: the driver types a leading `!` after a space.
    if (box === undefined || box.recalled || box.sign === '!') return false;
    return !showsSpinner(rows, box) && showsWholeOrEnd(box, prompt);
  },
};

/**
 * Tells whether the box shows a text, every run of whitespace left out:
 * the whole of it, or its end. A text taller than the box shows scrolled
 * to its end, the cursor there, its rule telling the rows hidden above
 * (`─── ↑ 5 more ───`): the rows shown are then the text's end, and the
 * text is longer than they are.
 */
function showsWholeOrEnd(box: InputBoxView, text: string): boolean {
  const shown = withoutWhitespace(box.text);
  const whole = withoutWhitespace(text);
  if (shown === '' || box.hiddenBelow > 0) return false;
  if (box.hiddenAbove === 0) return shown === whole;
  return whole.length > shown.length && whole.endsWith(shown);
}

/**
 * Gives a text with every run of whitespace left out: what the box shows
 * of a text compares so, since the box wraps a line onto rows where a
 * space was.
 *
 * @param text - The text.
 */
export function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Tells whether the agent works on a turn or a compaction: either sign of it shows. */
function isWorking(rows: readonly string[], box: InputBoxView): boolean {
  const footer = rows.slice(box.lastRow + 2).join('\n');
  return footer.includes(WORKING_HINT) || showsSpinner(rows, box);
}

function showsSpinner(rows: readonly string[], box: InputBoxView): boolean {
  return SPINNER_ROW.test(lastRowAbove(rows, box));
}

/** The last row of the conversation above the input box: the first unindented one above its rule. */
function lastRowAbove(rows: readonly string[], box: InputBoxView): string {
  const above = rows.slice(0, box.firstRow - 1);
  return above.findLast((row) => row.trim() !== '' && !row.startsWith(' ')) ?? '';
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
