import type { StartUpDialogKind } from './configuration.ts';
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
  /** The text in the input box. */
  readonly input: string;
  /** The start-up dialog that covers the screen, if any: Claude Code draws nothing else then. */
  readonly startUpDialog?: ShownStartUpDialog | undefined;
  /** What the agent printed as it left, below what it showed. */
  readonly farewell?: readonly string[] | undefined;
}

/** The width of a terminal that does not say its own. */
const DEFAULT_WIDTH = 80;

/**
 * The footer under the input box, as Claude Code 2.1.332 draws it in the
 * modes and states it was seen in; none in the others.
 */
const FOOTERS: Readonly<Record<string, Partial<Record<AgentState, string>>>> = {
  default: {
    idle: '⏸ manual mode on · ? for shortcuts · ← for agents',
    busy: '⏸ manual mode on · esc to interrupt · ← for agents',
  },
  bypassPermissions: { idle: '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents' },
};

/**
 * Renders the screen. A start-up dialog is drawn as Claude Code draws it,
 * alone. Otherwise one fact a line, always in the same order, so that a
 * test finds each by its label; then, once the session started, the input
 * box between two rules as Claude Code draws it (`❯`, the text), and the
 * footer of the mode where it is known.
 *
 * @param view - What to show.
 * @param width - The terminal's width, for the rules.
 * @returns The rows, top to bottom.
 */
export function renderScreen(view: ScreenView, width = DEFAULT_WIDTH): string[] {
  const shown = view.startUpDialog
    ? renderStartUpDialog(
        view.startUpDialog.kind,
        view.startUpDialog.selected,
        view.startUpDialog.subjects,
        width,
      )
    : [...facts(view), ...inputBox(view, width)];
  return [...shown, ...(view.farewell ?? [])];
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

/** Seen of Claude Code: the box is drawn once the session started; keys typed before are kept in it. */
function inputBox(view: ScreenView, width: number): string[] {
  const rows = view.input.split('\n').map((line, index) => `${index === 0 ? '❯ ' : '  '}${line}`);
  if (view.state === 'starting') return rows;
  const rule = '─'.repeat(width);
  const footer = FOOTERS[view.permissionMode]?.[view.state];
  return [rule, ...rows, rule, ...(footer === undefined ? [] : [`  ${footer}`])];
}
