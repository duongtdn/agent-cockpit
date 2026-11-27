import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import type { ScreenReading } from '../../src/server/driver.ts';

/**
 * Screens of Claude Code 2.1.332, as `tmux capture-pane` gave them in a
 * 120×40 pane, trailing blanks removed: each start-up dialog, the ready
 * input box, local commands given as the launch prompt, and (`s6-`) the
 * agent busy and idle, a draft in the box or none, in each mode. Named
 * `<case>-<step>`: `-0` after the launch, `-1` after the first keys, and so
 * on; the temporary paths in them differ per capture.
 */
const SCREENS = fileURLToPath(new URL('../fixtures/screens/', import.meta.url));

const TRUST: ScreenReading = { shows: 'dialog', dialog: 'trust-folder' };
const BYPASS: ScreenReading = { shows: 'dialog', dialog: 'bypass-permissions' };
const ONBOARDING: ScreenReading = { shows: 'dialog', dialog: 'onboarding' };
const LOGIN: ScreenReading = { shows: 'dialog', dialog: 'login' };
const UNNAMED: ScreenReading = { shows: 'dialog' };
const READY: ScreenReading = { shows: 'ready' };
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
  's1-trust-yes-2': READY,
  // Trust, then the bypass warning, then the session.
  's1-trust-bypass-0': TRUST,
  's1-trust-bypass-1': TRUST,
  's1-trust-bypass-2': BYPASS,
  's1-trust-bypass-3': BYPASS,
  's1-trust-bypass-4': READY,
  's1-bypass-0': BYPASS,
  's1-bypass-1': BYPASS,
  's1-bypass-esc-0': BYPASS,
  's1-bypass-esc-1': BYPASS,
  's1-bypass-yes-0': BYPASS,
  's1-bypass-yes-1': BYPASS,
  's1-bypass-yes-2': READY,
  // The first run: the theme picker and the security notes, then the session.
  's1-onboarding-0': ONBOARDING,
  's1-onboarding-1': ONBOARDING,
  's1-onboarding-2': READY,
  's1-onboarding-3': READY,
  's1-onboarding-4': READY,
  's1-onboarding-5': READY,
  // No key: the theme picker, then the choice of a login method.
  's1-login-nokey-0': ONBOARDING,
  's1-login-nokey-1': LOGIN,
  's1-login-noconfig-0': ONBOARDING,
  's1-login-noconfig-1': LOGIN,
  // No key and no network: the agent says so and exits; nothing to answer.
  's1-offline-nokey-0': NOTHING,
  // The custom API-key question: a dialog with no name.
  's1-apikey-0': UNNAMED,
  's1-apikey-1': READY,
  // The ready input box: with no prompt, after one, with hooks off.
  's1-ready-noprompt-final': READY,
  's1-ready-prompt-final': READY,
  's1-hooksoff-0': READY,
  's1-slowmcp-noprompt-ready-at-452ms': READY,
  's1-slowmcp-noprompt-final': READY,
  's1-slowmcp-prompt-final': READY,
  // The box drawn while the agent works: not ready for a prompt.
  's1-slowmcp-prompt-ready-at-439ms': NOTHING,
  // Local commands as the launch prompt: the box back, but for /help's panel.
  's2-clear-launch': READY,
  's2-clear-typed': READY,
  's2-compact-launch': READY,
  's2-compact-typed': READY,
  's2-context-launch': READY,
  's2-context-typed': READY,
  's2-help-launch': UNNAMED,
  's2-help-typed': UNNAMED,
  's2-help-esc-launch': UNNAMED,
  's2-help-esc-after-Escape': READY,
  's2-help-esc-typed': READY,
  // Sessions after a turn, with the sandbox and the person's settings.
  's3-fake-fail-tui': READY,
  's3-fake-nofail-tui': READY,
  's3-missing-nofail-tui': READY,
  's3-missing-unset-tui': READY,
  's5-control-inherited': READY,
  's5-settings-base-url': READY,
  's5-settings-quiet-only': READY,
  // The agent retrying the API: working, not ready.
  's5-settings-bedrock': NOTHING,
  // A turn and a compaction in each mode the driver runs, a draft in the box or none: busy
  // shows the spinner's row above the box, whatever the footer says; idle, none.
  ...byMode({
    'busy-empty': NOTHING,
    'busy-draft': NOTHING,
    'idle-empty': READY,
    'idle-draft': READY,
    'compacting-empty': NOTHING,
    'compacting-draft': NOTHING,
    'after-compact': READY,
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
  's6-idle-background-shell-empty': READY,
  's6-idle-background-shell-draft': READY,
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
    ['s1-ready-noprompt-final', READY],
    ['s6-default-busy-draft', NOTHING],
    ['s6-hook-PreToolUse-draft', NOTHING],
    ['s6-default-idle-draft', READY],
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

    expect(readScreen(quoted)).toEqual(READY);
  });

  it('takes no input box that a rule does not close for one ready', () => {
    const open = screen('s1-ready-noprompt-final').trimEnd().split('\n').slice(0, -2).join('\n');

    expect(readScreen(open)).toEqual(NOTHING);
  });

  it('takes the prompt arrow of a list for no input box', () => {
    const rule = '─'.repeat(120);
    expect(readScreen(`${rule}\n ❯ No, exit\n   Yes\n${rule}`)).toEqual(NOTHING);
  });

  it("takes no answer of the model's that ends in an ellipsis for the spinner", () => {
    const thinking = screen('s6-default-idle-draft').replace('● Ready.', '● Let me think…');

    expect(readScreen(thinking)).toEqual(READY);
  });

  it("takes no prompt of the person's that ends in an ellipsis for the spinner", () => {
    const interrupted = screen('s1-hooksoff-0').replace(
      /^● scripted answer$/m,
      '  ⎿  Interrupted · What should Claude do instead?',
    );

    expect(readScreen(interrupted.replace('❯ hello from launch', '❯ wait…'))).toEqual(READY);
  });

  it("reads a busy box as nothing by the footer's hint alone, the spinner's row out of sight", () => {
    const busy = screen('s6-default-busy-empty').replace(/^\S \S[^…]*….*$/mu, '');

    expect(readScreen(busy)).toEqual(NOTHING);
  });

  it('reads a box with text typed in it as ready', () => {
    const typed = screen('s1-ready-noprompt-final').replace(/^❯$/m, '❯ half a prompt');

    expect(readScreen(typed)).toEqual(READY);
  });
});
