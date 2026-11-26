/** What a session is doing, in the words of its screen. */
export type AgentState = 'starting' | 'idle' | 'busy' | 'waiting';

/** A dialog the terminal shows, which a person could answer with Enter or Esc. */
export interface Dialog {
  readonly kind: 'permission' | 'question';
  /** The tool the dialog is about. */
  readonly toolName: string;
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
}

/**
 * Renders the screen: one fact a line, always in the same order, so that a
 * test finds each by its label.
 *
 * @param view - What to show.
 * @returns The rows, top to bottom; the input box comes last.
 */
export function renderScreen(view: ScreenView): string[] {
  return [
    'fake agent',
    `session: ${view.sessionId}`,
    `mode: ${view.permissionMode}`,
    `state: ${view.state}`,
    ...(view.step === undefined ? [] : [`step: ${view.step}`]),
    `dialog: ${view.dialog ? `${view.dialog.kind} ${view.dialog.toolName}` : 'none'}`,
    `prompt: ${view.lastPrompt === undefined ? 'none' : JSON.stringify(view.lastPrompt)}`,
    ...(view.problem === undefined ? [] : [`problem: ${view.problem}`]),
    ...inputRows(view.input),
  ];
}

function inputRows(input: string): string[] {
  return input.split('\n').map((line, index) => `${index === 0 ? '> ' : '  '}${line}`);
}
