import { describe, expect, it } from 'vitest';
import { createInputBox, type DrawnBox } from '../support/fake-agent/input-box.ts';
import type { Key } from '../support/fake-agent/keys.ts';
import { drawScreen, renderScreen } from '../support/fake-agent/screen.ts';
import { START_UP_DIALOGS } from '../support/fake-agent/start-up-dialogs.ts';

const RULE = '─'.repeat(80);

/** The input box after keys, as drawn. */
function boxAfter(...keys: Key[]): DrawnBox {
  const box = createInputBox();
  for (const key of keys) box.press(key);
  return box.drawn();
}

function typed(text: string): DrawnBox {
  return boxAfter(
    ...text
      .split('\n')
      .flatMap((line, index): Key[] => [
        ...(index > 0 ? [{ kind: 'line-break' } as const] : []),
        { kind: 'text', text: line },
      ]),
  );
}

const view = {
  sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
  permissionMode: 'default',
  state: 'idle',
  step: undefined,
  dialog: undefined,
  lastPrompt: undefined,
  problem: undefined,
  box: typed(''),
} as const;

describe("the fake agent's screen", () => {
  it('shows the session, its mode, its state and an empty input box', () => {
    expect(renderScreen(view)).toEqual([
      'fake agent',
      'session: 6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
      'mode: default',
      'state: idle',
      'dialog: none',
      'prompt: none',
      RULE,
      '❯\u00a0',
      RULE,
      '  ⏸ manual mode on · ? for shortcuts · ← for agents',
    ]);
  });

  it('draws the input box between rules, as Claude Code does, only once the session started', () => {
    const starting = renderScreen({ ...view, state: 'starting', box: typed('early') });

    expect(starting.slice(-1)).toEqual(['❯\u00a0early']);
    expect(starting).not.toContain(RULE);
  });

  it('draws the footer of the modes and states it was seen in, and none in the others', () => {
    expect(renderScreen({ ...view, state: 'busy' }).at(-1)).toBe(
      '  ⏸ manual mode on · esc to interrupt · ← for agents',
    );
    expect(renderScreen({ ...view, permissionMode: 'bypassPermissions' }).at(-1)).toBe(
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    );
    expect(renderScreen({ ...view, permissionMode: 'plan' }).at(-1)).toBe(RULE);
    expect(renderScreen({ ...view, state: 'waiting' }).at(-1)).toBe(RULE);
  });

  it('draws a start-up dialog alone, as Claude Code draws it, its selected option marked', () => {
    const lines = renderScreen(
      {
        ...view,
        state: 'starting',
        startUpDialog: {
          kind: 'trust-folder',
          selected: 1,
          subjects: { folder: '/work/here', keySuffix: '' },
        },
      },
      40,
    );

    expect(lines).toEqual([
      '─'.repeat(40),
      ' Accessing workspace:',
      '',
      ' /work/here',
      '',
      ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
      " project, or work from your team). If not, take a moment to review what's in this folder first.",
      '',
      " Claude Code'll be able to read, edit, and execute files here.",
      '',
      ' Security guide',
      '',
      '   No, exit',
      ' ❯ Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ]);
  });

  it.each([
    [
      'bypass-permissions',
      'WARNING: Claude Code running in Bypass Permissions mode',
      '  ❯ No, exit',
    ],
    ['api-key', 'ANTHROPIC_API_KEY: sk-ant-...000000000-FAKEFAKEAA', '  ❯ No (recommended)'],
  ] as const)(
    'draws the %s dialog with its own text, its first selection',
    (kind, text, selected) => {
      const lines = renderScreen({
        ...view,
        startUpDialog: {
          kind,
          selected: START_UP_DIALOGS[kind].selected,
          subjects: { folder: '/work', keySuffix: '000000000-FAKEFAKEAA' },
        },
      });

      expect(lines).toContain(`  ${text}`);
      expect(lines).toContain(selected);
    },
  );

  it('shows what the agent printed as it left, below the rest', () => {
    expect(renderScreen({ ...view, farewell: ['Gone.'] }).at(-1)).toBe('Gone.');
  });

  it('shows the last prompt on one line, whatever it holds', () => {
    const lines = renderScreen({ ...view, state: 'busy', lastPrompt: 'one\ntwo' });

    expect(lines).toContain('state: busy');
    expect(lines).toContain('prompt: "one\\ntwo"');
  });

  it('shows the step a running turn plays, between its state and its dialog', () => {
    const lines = renderScreen({ ...view, state: 'busy', step: 'stay-busy' });

    expect(lines.slice(3, 6)).toEqual(['state: busy', 'step: stay-busy', 'dialog: none']);
  });

  it('shows the dialog a person could answer in place of the input box, as Claude Code does (behavior 9)', () => {
    const lines = renderScreen({
      ...view,
      state: 'waiting',
      dialog: { kind: 'permission', toolName: 'Bash' },
      box: typed('a draft'),
    });

    expect(lines).toContain('dialog: permission Bash');
    expect(lines).not.toContain(RULE);
    expect(lines).not.toContain('❯\u00a0a draft');
  });

  it('shows what is in the input box, line by line, and the footer of a box with text', () => {
    expect(renderScreen({ ...view, box: typed('one\ntwo') }).slice(-4)).toEqual([
      '❯\u00a0one',
      '  two',
      RULE,
      '  ⏸ manual mode on',
    ]);
  });

  it('draws the footer of an empty box over the invisible separator alone', () => {
    expect(renderScreen({ ...view, box: typed('\u2063') }).slice(-3)).toEqual([
      '❯\u00a0',
      RULE,
      '  ⏸ manual mode on · ? for shortcuts · ← for agents',
    ]);
  });

  it('draws shell mode with its sign and its footer', () => {
    expect(renderScreen({ ...view, box: typed('!ls') }).slice(-3)).toEqual([
      '!\u00a0ls',
      RULE,
      '  ! for shell mode',
    ]);
  });

  it("puts the terminal's cursor on the input box's, counted up from the last row", () => {
    expect(drawScreen({ ...view, box: typed('one\ntwo') }).cursor).toEqual({
      rowsUp: 2,
      column: 5,
    });
    expect(drawScreen({ ...view, state: 'starting', box: typed('early') }).cursor).toEqual({
      rowsUp: 0,
      column: 7,
    });
    expect(
      drawScreen({ ...view, state: 'waiting', dialog: { kind: 'permission', toolName: 'Bash' } })
        .cursor,
    ).toBeUndefined();
  });

  it('says on the rules what a scrolled box hides, three dashes in', () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n');
    const screen = renderScreen({ ...view, box: typed(lines) }, 120);
    const rules = screen.filter((line) => line.startsWith('─'));

    expect(rules).toEqual([`─── ↑ 10 more ${'─'.repeat(106)}`, '─'.repeat(120)]);
  });

  it('shows a problem with the script', () => {
    expect(renderScreen({ ...view, problem: 'turn 1 has no step' })).toContain(
      'problem: turn 1 has no step',
    );
  });
});
