import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import type { ScreenReading } from '../../src/server/driver.ts';

/**
 * Screens of Claude Code 2.1.332, as `tmux capture-pane` gave them in a
 * 120×40 pane, trailing blanks removed: each start-up dialog, the ready
 * input box, local commands given as the launch prompt, (`s6-`) the
 * agent busy and idle, a draft in the box or none, in each mode, and
 * (`s7-`) the panels a launch prompt opens and the box once one closed, and
 * (`s8-`) an early Esc's screens: the prompt withdrawn into the empty box,
 * the turn interrupted over a draft, the busy screens before it, a prompt
 * glued to a draft, a permission dialog, a prompt taller than the box withdrawn. Named `<case>-<step>`: `-0` after the launch, `-1` after the first keys, and so
 * on; the temporary paths in them differ per capture.
 */
const SCREENS = fileURLToPath(new URL('../fixtures/screens/', import.meta.url));

const TRUST: ScreenReading = { shows: 'dialog', dialog: 'trust-folder' };
const BYPASS: ScreenReading = { shows: 'dialog', dialog: 'bypass-permissions' };
const ONBOARDING: ScreenReading = { shows: 'dialog', dialog: 'onboarding' };
const LOGIN: ScreenReading = { shows: 'dialog', dialog: 'login' };
const UNNAMED: ScreenReading = { shows: 'dialog' };
const INPUT_BOX: ScreenReading = { shows: 'input-box' };
const UNKNOWN: ScreenReading = { shows: 'unknown' };
const panel = (name: string): ScreenReading => ({ shows: 'panel', panel: name });
const NOTHING: ScreenReading = { shows: 'nothing' };

/** What each saved screen shows, by its file's name. */
const EXPECTED: Readonly<Record<string, ScreenReading>> = {
  // The trust dialog: before and after Down, and as the agent exits on "No, exit".
  's1-trust-0': TRUST,
  's1-trust-1': TRUST,
  's1-trust-esc-0': TRUST,
  's1-trust-esc-1': TRUST,
  's1-trust-yes-0': TRUST,
  's1-trust-yes-1': TRUST,
  's1-trust-yes-2': INPUT_BOX,
  // Trust, then the bypass warning, then the session.
  's1-trust-bypass-0': TRUST,
  's1-trust-bypass-1': TRUST,
  's1-trust-bypass-2': BYPASS,
  's1-trust-bypass-3': BYPASS,
  's1-trust-bypass-4': INPUT_BOX,
  's1-bypass-0': BYPASS,
  's1-bypass-1': BYPASS,
  's1-bypass-esc-0': BYPASS,
  's1-bypass-esc-1': BYPASS,
  's1-bypass-yes-0': BYPASS,
  's1-bypass-yes-1': BYPASS,
  's1-bypass-yes-2': INPUT_BOX,
  // The first run: the theme picker and the security notes, then the session.
  's1-onboarding-0': ONBOARDING,
  's1-onboarding-1': ONBOARDING,
  's1-onboarding-2': INPUT_BOX,
  's1-onboarding-3': INPUT_BOX,
  's1-onboarding-4': INPUT_BOX,
  's1-onboarding-5': INPUT_BOX,
  // No key: the theme picker, then the choice of a login method.
  's1-login-nokey-0': ONBOARDING,
  's1-login-nokey-1': LOGIN,
  's1-login-noconfig-0': ONBOARDING,
  's1-login-noconfig-1': LOGIN,
  // No key and no network: the agent says so and exits; nothing to answer, and no screen the driver knows.
  's1-offline-nokey-0': UNKNOWN,
  // The custom API-key question: a dialog with no name.
  's1-apikey-0': UNNAMED,
  's1-apikey-1': INPUT_BOX,
  // The ready input box: with no prompt, after one, with hooks off.
  's1-ready-noprompt-final': INPUT_BOX,
  's1-ready-prompt-final': INPUT_BOX,
  's1-hooksoff-0': INPUT_BOX,
  's1-slowmcp-noprompt-ready-at-452ms': INPUT_BOX,
  's1-slowmcp-noprompt-final': INPUT_BOX,
  's1-slowmcp-prompt-final': INPUT_BOX,
  // The box drawn while the agent works: not ready for a prompt.
  's1-slowmcp-prompt-ready-at-439ms': NOTHING,
  // Local commands as the launch prompt: the box back, but for /help's panel.
  's2-clear-launch': INPUT_BOX,
  's2-clear-typed': INPUT_BOX,
  's2-compact-launch': INPUT_BOX,
  's2-compact-typed': INPUT_BOX,
  's2-context-launch': INPUT_BOX,
  's2-context-typed': INPUT_BOX,
  's2-help-launch': panel('help'),
  's2-help-typed': panel('help'),
  's2-help-esc-launch': panel('help'),
  's2-help-esc-after-Escape': INPUT_BOX,
  's2-help-esc-typed': INPUT_BOX,
  // Sessions after a turn, with the sandbox and the person's settings.
  's3-fake-fail-tui': INPUT_BOX,
  's3-fake-nofail-tui': INPUT_BOX,
  's3-missing-nofail-tui': INPUT_BOX,
  's3-missing-unset-tui': INPUT_BOX,
  's5-control-inherited': INPUT_BOX,
  's5-settings-base-url': INPUT_BOX,
  's5-settings-quiet-only': INPUT_BOX,
  // The agent retrying the API: working, not ready.
  's5-settings-bedrock': NOTHING,
  // A turn and a compaction in each mode the driver runs, a draft in the box or none: busy
  // shows the spinner's row above the box, whatever the footer says; idle, none.
  ...byMode({
    'busy-empty': NOTHING,
    'busy-draft': NOTHING,
    'idle-empty': INPUT_BOX,
    'idle-draft': INPUT_BOX,
    'compacting-empty': NOTHING,
    'compacting-draft': NOTHING,
    'after-compact': INPUT_BOX,
  }),
  // A hook of the turn awaited, a tool running, an answer streaming: busy, a draft or none.
  ...Object.fromEntries(
    ['hook-UserPromptSubmit', 'hook-PreToolUse', 'hook-PostToolUse', 'hook-Stop']
      .concat(['tool-running', 'streaming'])
      .flatMap((name) => [
        [`s6-${name}-empty`, NOTHING],
        [`s6-${name}-draft`, NOTHING],
      ]),
  ),
  // Idle with a background shell: the turn's last row says the shell runs on.
  's6-idle-background-shell-empty': INPUT_BOX,
  's6-idle-background-shell-draft': INPUT_BOX,
  // Panels a launch prompt opens, each by its name (`/config`'s with a search typed, and its list after an Esc), and the box
  // once one closed (Esc on `/cost`'s, a choice on `/model`'s); the box drawn while the agent's
  // SessionStart hook runs, before it takes the prompt: working, nothing to type into.
  's7-cost-launch': panel('cost'),
  's7-status-launch': panel('status'),
  's7-config-launch': panel('config'),
  's7-config-search': panel('config'),
  's7-config-list': panel('config'),
  's7-model-launch': panel('model'),
  's7-cost-closed': INPUT_BOX,
  's7-model-chosen': INPUT_BOX,
  's7-start-hook-running': NOTHING,
  // An early Esc over an empty box withdraws the prompt into it (one line, five lines, one line
  // wrapped over four rows); over a draft it interrupts, the draft alone left in the box. Before
  // the Esc, the spinner's row above the box, empty or holding a draft. The prompt and a draft
  // glued in the box, and a permission dialog the agent draws over it, which no hint names.
  's8-withdrawn-one-line': INPUT_BOX,
  's8-withdrawn-five-lines': INPUT_BOX,
  's8-withdrawn-wrapped-line': INPUT_BOX,
  // A prompt taller than the box withdrawn (20 lines, 40 lines, one line wrapped over 20 rows):
  // the box scrolled to its end, its rule saying how many rows are hidden above.
  's8-withdrawn-20-lines-scrolled': INPUT_BOX,
  's8-withdrawn-40-lines-scrolled': INPUT_BOX,
  's8-withdrawn-wrapped-20-rows-scrolled': INPUT_BOX,
  's8-interrupted-over-a-draft': INPUT_BOX,
  's8-busy-prompt-above-an-empty-box': NOTHING,
  's8-busy-a-draft-in-the-box': NOTHING,
  's8-prompt-glued-to-a-draft': INPUT_BOX,
  's8-permission-dialog': UNKNOWN,
};

/** The screens of each case in each mode the driver runs, named `s6-<mode>-<case>`. */
function byMode(cases: Readonly<Record<string, ScreenReading>>): Record<string, ScreenReading> {
  return Object.fromEntries(
    ['default', 'acceptEdits', 'plan', 'bypassPermissions'].flatMap((mode) =>
      Object.entries(cases).map(([name, reading]) => [`s6-${mode}-${name}`, reading]),
    ),
  );
}

function screen(name: string): string {
  return readFileSync(`${SCREENS}${name}.txt`, 'utf8');
}

/** A screen of the input box's own fixtures: a draft scrolled, an entry recalled from the history. */
function inputBoxScreen(name: string): string {
  return readFileSync(new URL(`../fixtures/input-box/${name}.txt`, import.meta.url), 'utf8');
}

const readScreen = (text: string) => claudeCode().readScreen(text);

/** Wraps every row longer than the width at its last space before it, as the agent's own layout does in a narrower terminal. */
function narrowed(text: string, width: number): string {
  return text
    .split('\n')
    .flatMap((row) => wrap(row, width))
    .join('\n');
}

function wrap(row: string, width: number): string[] {
  if (row.length <= width || !row.trim().includes(' ')) return [row.slice(0, width)];
  const cut = row.lastIndexOf(' ', width);
  if (cut <= row.search(/\S/)) return [row.slice(0, width)];
  return [row.slice(0, cut), ...wrap(` ${row.slice(cut + 1)}`, width)];
}

describe("the Claude Code driver's reading of the screen", () => {
  it('has an expectation for every saved screen', () => {
    const saved = readdirSync(SCREENS)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => name.slice(0, -'.txt'.length));

    expect(saved.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('reads %s', (name, reading) => {
    expect(readScreen(screen(name))).toEqual(reading);
  });

  it.each([
    ['s1-trust-0', TRUST],
    ['s1-bypass-0', BYPASS],
    ['s1-onboarding-0', ONBOARDING],
    ['s1-onboarding-1', ONBOARDING],
    ['s1-login-nokey-1', LOGIN],
    ['s1-apikey-0', UNNAMED],
    ['s1-ready-noprompt-final', INPUT_BOX],
    ['s6-default-busy-draft', NOTHING],
    ['s6-hook-PreToolUse-draft', NOTHING],
    ['s6-default-idle-draft', INPUT_BOX],
  ])('reads %s the same in a terminal 60 columns wide, its sentences wrapped', (name, reading) => {
    expect(readScreen(narrowed(screen(name), 60))).toEqual(reading);
  });

  it('tells nothing of a blank screen: the agent has drawn nothing yet', () => {
    expect(readScreen('')).toEqual(NOTHING);
    expect(readScreen('\n\n\n')).toEqual(NOTHING);
  });

  it("takes no dialog's words in the conversation above the input box for the dialog", () => {
    const quoted = screen('s1-hooksoff-0').replace(
      '● scripted answer',
      '● Accessing workspace: Yes, I trust this folder · Select login method: · Enter to confirm · Esc to cancel',
    );

    expect(readScreen(quoted)).toEqual(INPUT_BOX);
  });

  it('takes no input box that a rule does not close for one', () => {
    const open = screen('s1-ready-noprompt-final').trimEnd().split('\n').slice(0, -2).join('\n');

    expect(readScreen(open)).toEqual(UNKNOWN);
  });

  it('takes the prompt arrow of a list for no input box', () => {
    const rule = '─'.repeat(120);
    expect(readScreen(`${rule}\n ❯ No, exit\n   Yes\n${rule}`)).toEqual(UNKNOWN);
  });

  it("takes no answer of the model's that ends in an ellipsis for the spinner", () => {
    const thinking = screen('s6-default-idle-draft').replace('● Ready.', '● Let me think…');

    expect(readScreen(thinking)).toEqual(INPUT_BOX);
  });

  it("takes no prompt of the person's that ends in an ellipsis for the spinner", () => {
    const interrupted = screen('s1-hooksoff-0').replace(
      /^● scripted answer$/m,
      '  ⎿  Interrupted · What should Claude do instead?',
    );

    expect(readScreen(interrupted.replace('❯ hello from launch', '❯ wait…'))).toEqual(INPUT_BOX);
  });

  it("reads a busy box as nothing by the footer's hint alone, the spinner's row out of sight", () => {
    const busy = screen('s6-default-busy-empty').replace(/^\S \S[^…]*….*$/mu, '');

    expect(readScreen(busy)).toEqual(NOTHING);
  });

  it('reads a box with text typed in it as free to type into', () => {
    const typed = screen('s1-ready-noprompt-final').replace(/^❯$/m, '❯ half a prompt');

    expect(readScreen(typed)).toEqual(INPUT_BOX);
  });
});

describe("the Claude Code driver's sign on screen that a panel a launch prompt opened closed", () => {
  const closed = (name: string) => claudeCode().screenStateSigns.launchPanelClosed(screen(name));

  it.each(['s2-help-esc-after-Escape', 's7-cost-closed', 's7-model-chosen'])(
    'reads %s: the box back, no spinner above it',
    (name) => {
      expect(closed(name)).toBe(true);
    },
  );

  it.each([
    's2-help-launch',
    's7-cost-launch',
    's7-status-launch',
    's7-config-launch',
    's7-config-search',
    's7-config-list',
    's7-model-launch',
  ])('reads no close on %s: the panel shows', (name) => {
    expect(closed(name)).toBe(false);
  });

  it.each(
    Object.keys(EXPECTED).filter(
      (name) => name.startsWith('s6-') && EXPECTED[name]?.shows === 'nothing',
    ),
  )('reads no close on %s: the spinner shows above the box, a draft in it or none', (name) => {
    expect(closed(name)).toBe(false);
  });

  it("reads the spinner's row alone, never the footer: its hint, which a draft hides, is no sign", () => {
    const hintOnly = screen('s6-default-busy-empty').replace(/^\S \S[^…]*….*$/mu, '');

    expect(closed('s6-default-busy-draft')).toBe(false);
    expect(claudeCode().screenStateSigns.launchPanelClosed(hintOnly)).toBe(true);
  });

  it('reads no close on a screen with no input box: blank, or one the driver does not know', () => {
    expect(claudeCode().screenStateSigns.launchPanelClosed('')).toBe(false);
    expect(closed('s1-offline-nokey-0')).toBe(false);
  });
});

describe("the Claude Code driver's sign on screen that an early Esc withdrew the turn's prompt", () => {
  const FIVE_LINES = 'p-one first line\np-two\np-three\np-four\np-five last';
  const WRAPPED_LINE = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
  const tallLines = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `tall line ${String(index + 1).padStart(2, '0')}`,
    ).join('\n');
  const LONG_WRAPPED_LINE = Array.from({ length: 480 }, (_, index) => `w${index}`).join(' ');
  const withdrawn = (name: string, prompt: string) =>
    claudeCode().screenStateSigns.promptWithdrawn(screen(name), prompt);

  it.each([
    ['s8-withdrawn-one-line', 'withdraw me'],
    ['s8-withdrawn-five-lines', FIVE_LINES],
    ['s8-withdrawn-wrapped-line', WRAPPED_LINE],
  ])('reads %s: the box holds the prompt, no spinner above it', (name, prompt) => {
    expect(withdrawn(name, prompt)).toBe(true);
  });

  it.each([
    ['s8-withdrawn-20-lines-scrolled', tallLines(20)],
    ['s8-withdrawn-40-lines-scrolled', tallLines(40)],
    ['s8-withdrawn-wrapped-20-rows-scrolled', LONG_WRAPPED_LINE],
  ])(
    'reads %s: a box scrolled to its end, rows hidden above, shows the end of the prompt',
    (name, prompt) => {
      expect(withdrawn(name, prompt)).toBe(true);
    },
  );

  it('reads no withdrawal from a box scrolled to its end whose text is not the end of the prompt', () => {
    expect(withdrawn('s8-withdrawn-20-lines-scrolled', tallLines(19))).toBe(false);
    expect(withdrawn('s8-withdrawn-20-lines-scrolled', `${tallLines(20)}\none more`)).toBe(false);
    expect(withdrawn('s8-withdrawn-40-lines-scrolled', tallLines(20))).toBe(false);
  });

  it('compares with every run of whitespace left out: the box breaks a wrapped line where a space was', () => {
    expect(withdrawn('s8-withdrawn-wrapped-line', WRAPPED_LINE.replaceAll(' ', '  '))).toBe(true);
    expect(withdrawn('s8-withdrawn-five-lines', FIVE_LINES.replaceAll('\n', ' '))).toBe(true);
  });

  it('reads no withdrawal where the turn was interrupted over a draft: the box holds the draft alone', () => {
    expect(withdrawn('s8-interrupted-over-a-draft', 'the sent prompt')).toBe(false);
  });

  it('reads no withdrawal where the box holds the prompt and more, or another text', () => {
    expect(withdrawn('s8-prompt-glued-to-a-draft', 'the sent prompt')).toBe(false);
    expect(withdrawn('s8-withdrawn-one-line', 'withdraw')).toBe(false);
    expect(withdrawn('s8-withdrawn-one-line', 'withdraw me now')).toBe(false);
  });

  it("reads no withdrawal while the spinner's row shows: the prompt above an empty box, or the text in the box", () => {
    expect(withdrawn('s8-busy-prompt-above-an-empty-box', 'withdraw me')).toBe(false);
    expect(withdrawn('s8-busy-a-draft-in-the-box', 'my one-line draft')).toBe(false);
  });

  it("reads the spinner's row, never the footer: the box under a spinner's row holds no withdrawn prompt", () => {
    const spinnerOverThePrompt = screen('s8-busy-a-draft-in-the-box').replace(
      '❯ my one-line draft',
      '❯ withdraw me',
    );
    const footerHintOnly = screen('s8-withdrawn-one-line').replace(
      '⏸ manual mode on',
      '⏸ manual mode on · esc to interrupt · ← for agents',
    );

    expect(claudeCode().screenStateSigns.promptWithdrawn(spinnerOverThePrompt, 'withdraw me')).toBe(
      false,
    );
    expect(claudeCode().screenStateSigns.promptWithdrawn(footerHintOnly, 'withdraw me')).toBe(true);
  });

  it('reads no withdrawal where no input box shows: a dialog over it, a blank screen, one it does not know', () => {
    expect(withdrawn('s8-permission-dialog', 'Make a file')).toBe(false);
    expect(withdrawn('s1-trust-0', 'withdraw me')).toBe(false);
    expect(claudeCode().screenStateSigns.promptWithdrawn('', 'withdraw me')).toBe(false);
    expect(withdrawn('s1-offline-nokey-0', 'withdraw me')).toBe(false);
  });

  it('reads no withdrawal from a box scrolled whose prompt is no longer than what it shows: the box holds more', () => {
    const scrolled = inputBoxScreen('a1-draft-25-lines-cursor-up-1-downs');
    const shown = Array.from(
      { length: 15 },
      (_, index) => `draft line ${String(index + 11).padStart(2, '0')}`,
    ).join('\n');

    expect(claudeCode().screenStateSigns.promptWithdrawn(scrolled, shown)).toBe(false);
  });

  it('reads no withdrawal from a box scrolled off its end, rows hidden below: the cursor is not at the end', () => {
    const scrolled = inputBoxScreen('a1-draft-25-lines-cursor-up-0-setup');
    // The rows it shows end the text compared: only the rows hidden below tell it is not the box's end.
    const draft = Array.from(
      { length: 22 },
      (_, index) => `draft line ${String(index + 1).padStart(2, '0')}`,
    ).join('\n');

    expect(claudeCode().screenStateSigns.promptWithdrawn(scrolled, draft)).toBe(false);
  });

  it('reads no withdrawal of an empty prompt from an empty box: nothing was withdrawn', () => {
    expect(withdrawn('s1-ready-noprompt-final', '')).toBe(false);
  });

  it('reads no withdrawal from an entry the person recalled from the history, the same text in it', () => {
    const recalled = inputBoxScreen('b1-history-empty-box-up-0-setup');

    expect(claudeCode().screenStateSigns.promptWithdrawn(recalled, 'past prompt two')).toBe(false);
  });
});
