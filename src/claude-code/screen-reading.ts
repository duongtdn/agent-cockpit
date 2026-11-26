import type { ScreenReading } from '../server/driver.js';
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

/** The rule above and below the input box. */
const RULE = /^─{8,}$/;

/** What starts the input box's first row, the text typed after it. */
const PROMPT_ARROW = '❯';

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
 * Finds the input box at the bottom of the screen, between its two rules,
 * its first row the prompt arrow: the rows below it, the footer, joined;
 * `undefined` when the screen shows no such box.
 */
function footerOfInputBox(rows: readonly string[]): string | undefined {
  const rules = rows.flatMap((row, index) => (RULE.test(row.trim()) ? [index] : []));
  const [opening, closing] = rules.slice(-2);
  if (opening === undefined || closing === undefined) return undefined;
  if (!rows[opening + 1]?.startsWith(PROMPT_ARROW)) return undefined;
  return rows.slice(closing + 1).join('\n');
}
