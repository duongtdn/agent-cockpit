import type { StartUpDialogKind } from './configuration.ts';

/** What choosing an option of a start-up dialog does. */
export type StartUpAnswer = 'accept' | 'decline-and-exit' | 'reject-key';

/** An option of a start-up dialog. */
export interface StartUpOption {
  readonly label: string;
  readonly answer: StartUpAnswer;
}

/** A start-up dialog as Claude Code 2.1.332 draws it: its text, its options, the one selected first. */
export interface StartUpDialogText {
  /** The lines above the options; `{folder}` and `{key}` stand for the session's. */
  readonly lines: readonly string[];
  readonly options: readonly StartUpOption[];
  /** The option selected when the dialog shows. */
  readonly selected: number;
  /** How far each line is indented. */
  readonly indent: string;
  /** What Esc does: the answer of an option, or nothing observed. */
  readonly escape: StartUpAnswer | undefined;
}

const CONFIRM_LINE = 'Enter to confirm · Esc to cancel';

/** Each dialog's text, as the spike's captures of 2.1.332 show it (blank lines included). */
export const START_UP_DIALOGS: Readonly<Record<StartUpDialogKind, StartUpDialogText>> = {
  'trust-folder': {
    lines: [
      'Accessing workspace:',
      '',
      '{folder}',
      '',
      'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
      "project, or work from your team). If not, take a moment to review what's in this folder first.",
      '',
      "Claude Code'll be able to read, edit, and execute files here.",
      '',
      'Security guide',
      '',
    ],
    options: [
      { label: 'No, exit', answer: 'decline-and-exit' },
      { label: 'Yes, I trust this folder', answer: 'accept' },
    ],
    selected: 0,
    indent: ' ',
    escape: 'decline-and-exit',
  },
  'bypass-permissions': {
    lines: [
      'WARNING: Claude Code running in Bypass Permissions mode',
      '',
      'In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous',
      'commands.',
      'This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be',
      'restored if damaged.',
      '',
      'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
      '',
      'https://code.claude.com/docs/en/security',
      '',
    ],
    options: [
      { label: 'No, exit', answer: 'decline-and-exit' },
      { label: 'Yes, I accept', answer: 'accept' },
    ],
    selected: 0,
    indent: '  ',
    escape: 'decline-and-exit',
  },
  'api-key': {
    lines: [
      'Detected a custom API key in your environment',
      '',
      'ANTHROPIC_API_KEY: sk-ant-...{key}',
      '',
      'Do you want to use this API key?',
      '',
    ],
    options: [
      { label: 'Yes', answer: 'accept' },
      { label: 'No (recommended)', answer: 'reject-key' },
    ],
    selected: 1,
    indent: '  ',
    escape: undefined,
  },
};

/** What Claude Code prints when the person leaves at the trust dialog, below it. */
export const UNTRUSTED_EXIT_LINES: readonly string[] = [
  '',
  "Claude Code didn't start because this folder isn't trusted.",
  'Run claude again and choose Yes, or run it in another folder.',
];

/** What a dialog's text stands for: the session's folder and the key's last characters. */
export interface DialogSubjects {
  readonly folder: string;
  readonly keySuffix: string;
}

/**
 * Draws a start-up dialog as Claude Code does: a rule the width of the
 * terminal, the text, the options with the selected one marked, how to answer.
 *
 * @param kind - The dialog.
 * @param selected - The option selected now.
 * @param subjects - What its text names.
 * @param width - The terminal's width, for the rule.
 * @returns The rows, top to bottom.
 */
export function renderStartUpDialog(
  kind: StartUpDialogKind,
  selected: number,
  subjects: DialogSubjects,
  width: number,
): string[] {
  const dialog = START_UP_DIALOGS[kind];
  const named = (line: string) =>
    line.replace('{folder}', subjects.folder).replace('{key}', subjects.keySuffix);
  const indented = (line: string) => (line === '' ? '' : dialog.indent + line);
  return [
    '─'.repeat(width),
    ...dialog.lines.map(named).map(indented),
    ...dialog.options.map(
      (option, index) => `${dialog.indent}${index === selected ? '❯' : ' '} ${option.label}`,
    ),
    '',
    indented(CONFIRM_LINE),
  ];
}
