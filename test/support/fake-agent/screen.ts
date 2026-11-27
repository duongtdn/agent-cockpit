import type { StartUpDialogKind } from './configuration.ts';
import type { DrawnBox } from './input-box.ts';
import { type DialogSubjects, renderStartUpDialog } from './start-up-dialogs.ts';

/** What a session is doing, in the words of its screen. */
export type AgentState = 'starting' | 'idle' | 'busy' | 'waiting';

/** A dialog the terminal shows, which a person could answer with Enter or Esc. */
export interface Dialog {
  readonly kind: 'permission' | 'question';
  /** The tool the dialog is about. */
  readonly toolName: string;
}

/** A start-up dialog on screen, before any hook. */
export interface ShownStartUpDialog {
  readonly kind: StartUpDialogKind;
  /** The option selected now. */
  readonly selected: number;
  /** What its text names. */
  readonly subjects: DialogSubjects;
}

/** What the fake agent's screen shows. */
export interface ScreenView {
  readonly sessionId: string;
  readonly permissionMode: string;
  readonly state: AgentState;
  /** What the running turn does now, as its script names the step; none between turns. */
  readonly step: string | undefined;
  /** The dialog on screen, if any. */
  readonly dialog: Dialog | undefined;
  /** The last prompt taken, if any. */
  readonly lastPrompt: string | undefined;
  /** Why the agent fails, when it was asked to play what it cannot: its last screen says so. */
  readonly problem: string | undefined;
  /** The input box, as it is drawn. */
  readonly box: DrawnBox;
  /** Whether a subagent ran in the background and ended: the footer then says where to see it. */
  readonly subagentEnded?: boolean;
  /** Whether the agent compacts the conversation, on the person's `/compact`: its spinner says so. */
  readonly compacting?: boolean;
  /** The start-up dialog that covers the screen, if any: Claude Code draws nothing else then. */
  readonly startUpDialog?: ShownStartUpDialog | undefined;
  /** What the agent printed as it left, below what it showed. */
  readonly farewell?: readonly string[] | undefined;
}

/** The width of a terminal that does not say its own. */
const DEFAULT_WIDTH = 80;

/**
 * The mode's hint, the footer's first words, as Claude Code 2.1.332 draws
 * it in the modes it was seen in; no footer in the others.
 */
const MODE_HINTS: Readonly<Record<string, string>> = {
  default: '⏸ manual mode on',
  acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '⏸ plan mode on (shift+tab to cycle)',
  bypassPermissions: '⏵⏵ bypass permissions on (shift+tab to cycle)',
};
/**
 * What follows the mode's hint over an empty box, idle and busy; over text
 * the hint shows alone, idle or busy, in every mode.
 */
const HINTS_OVER_AN_EMPTY_BOX: Readonly<Record<'idle' | 'busy', string>> = {
  idle: '← for agents',
  busy: 'esc to interrupt · ← for agents',
};
/** Seen in the default mode only: its idle footer offers the shortcuts first. */
const DEFAULT_IDLE_SHORTCUTS = '? for shortcuts';
const SHELL_MODE_FOOTER = '! for shell mode';
/**
 * The spinner's row, which Claude Code draws above the box while it works,
 * a draft in the box or none: its verb changes from turn to turn (one seen
 * here), a compaction's says so.
 */
const SPINNER_OF_A_TURN = '✶ Frosting…';
const SPINNER_OF_A_COMPACTION = '✶ Compacting conversation…';
/** Seen of Claude Code once a subagent ended: a hint in place of the shortcuts', over an empty box and over text. */
const FOOTERS_AFTER_A_SUBAGENT = {
  empty: '⏸ manual mode on · /tasks to see subagents · ← for agents',
  overText: '⏸ manual mode on · /tasks to see subagents',
};

/**
 * Where a terminal's cursor is put: counted from the last row drawn, since
 * the rows above the box may be wider than the terminal and wrap there.
 */
export interface ScreenCursor {
  /** How many rows above the last one drawn. */
  readonly rowsUp: number;
  /** Its column, from 0. */
  readonly column: number;
}

/** A screen as drawn: its rows, and where the cursor goes, when the input box shows. */
export interface DrawnScreen {
  readonly rows: string[];
  readonly cursor: ScreenCursor | undefined;
}

/**
 * Renders the screen. A start-up dialog is drawn as Claude Code draws it,
 * alone. Otherwise one fact a line, always in the same order, so that a
 * test finds each by its label; then, once the session started, the input
 * box between two rules as Claude Code draws it (`❯`, the text), and the
 * footer of the mode where it is known. A dialog takes the box's place, as
 * in Claude Code: no box is drawn while one shows.
 *
 * @param view - What to show.
 * @param width - The terminal's width, for the rules.
 * @returns The rows, top to bottom.
 */
export function renderScreen(view: ScreenView, width = DEFAULT_WIDTH): string[] {
  return drawScreen(view, width).rows;
}

/**
 * Draws the screen as {@link renderScreen} does, and gives where the
 * terminal's cursor goes: where the input box's cursor is, as Claude Code
 * puts it; nowhere in particular when no box shows.
 *
 * @param view - What to show.
 * @param width - The terminal's width, for the rules.
 */
export function drawScreen(view: ScreenView, width = DEFAULT_WIDTH): DrawnScreen {
  const farewell = view.farewell ?? [];
  if (view.startUpDialog) {
    const { kind, selected, subjects } = view.startUpDialog;
    return {
      rows: [...renderStartUpDialog(kind, selected, subjects, width), ...farewell],
      cursor: undefined,
    };
  }
  const shownFacts = facts(view);
  if (view.dialog) return { rows: [...shownFacts, ...farewell], cursor: undefined };
  const box = inputBox(view, width);
  // Once the session started, the box has a rule above it.
  const cursorIndex = (view.state === 'starting' ? 0 : 1) + view.box.cursor.row;
  return {
    rows: [...shownFacts, ...spinner(view), ...box, ...farewell],
    cursor: {
      rowsUp: box.length - 1 - cursorIndex + farewell.length,
      column: view.box.cursor.column,
    },
  };
}

function facts(view: ScreenView): string[] {
  return [
    'fake agent',
    `session: ${view.sessionId}`,
    `mode: ${view.permissionMode}`,
    `state: ${view.state}`,
    ...(view.step === undefined ? [] : [`step: ${view.step}`]),
    `dialog: ${view.dialog ? `${view.dialog.kind} ${view.dialog.toolName}` : 'none'}`,
    `prompt: ${view.lastPrompt === undefined ? 'none' : JSON.stringify(view.lastPrompt)}`,
    ...(view.problem === undefined ? [] : [`problem: ${view.problem}`]),
  ];
}

/** Seen of Claude Code: while it works, its spinner's row is above the input box. */
function spinner(view: ScreenView): string[] {
  if (view.state !== 'busy') return [];
  return [view.compacting ? SPINNER_OF_A_COMPACTION : SPINNER_OF_A_TURN];
}

/** Seen of Claude Code: the box is drawn once the session started; keys typed before are kept in it. */
function inputBox(view: ScreenView, width: number): string[] {
  const { box } = view;
  if (view.state === 'starting') return [...box.rows];
  const footer = footerOf(view);
  return [
    rule(box.above, width),
    ...box.rows,
    rule(box.below, width),
    ...(footer === undefined ? [] : [`  ${footer}`]),
  ];
}

function footerOf({ box, permissionMode, state, subagentEnded }: ScreenView): string | undefined {
  const hint = MODE_HINTS[permissionMode];
  if (hint === undefined || (state !== 'idle' && state !== 'busy')) return undefined;
  if (permissionMode === 'default' && state === 'idle') {
    if (box.inShellMode) return SHELL_MODE_FOOTER;
    if (subagentEnded) {
      return box.looksEmpty ? FOOTERS_AFTER_A_SUBAGENT.empty : FOOTERS_AFTER_A_SUBAGENT.overText;
    }
  }
  if (!box.looksEmpty) return hint;
  const shortcuts =
    permissionMode === 'default' && state === 'idle' ? [DEFAULT_IDLE_SHORTCUTS] : [];
  return [hint, ...shortcuts, HINTS_OVER_AN_EMPTY_BOX[state]].join(' · ');
}

/** A rule across the terminal, with what it says after three of its dashes, as Claude Code draws it. */
function rule(label: string | undefined, width: number): string {
  if (label === undefined) return '─'.repeat(width);
  const start = `─── ${label} `;
  return start + '─'.repeat(Math.max(0, width - Array.from(start).length));
}
