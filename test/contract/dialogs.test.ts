import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import type { StartupDialog } from '../../src/shared/session.ts';
import { turn } from '../support/fake-api/index.ts';
import { type ContractCockpit, type HookPayload, startContractCockpit } from './cockpit-harness.ts';
import { answerYes, pressOnDialog } from './dialog-keys.ts';

/**
 * The start-up dialogs of the real agent, met by a cockpit as an app makes
 * one, with the driver's own launch: each shows before any hook, the
 * driver names it on the real screen, and the person's answer in the
 * terminal decides what the session becomes.
 */

const TRUST_DIALOG = 'Accessing workspace:';
const BYPASS_WARNING = 'WARNING: Claude Code running in Bypass Permissions mode';
const KEY_QUESTION = 'Do you want to use this API key?';
const THEME_PICKER = 'Choose the text style that looks best with your terminal';
const SECURITY_NOTES = 'Security notes:';

const { readScreen } = claudeCode();

function eventsOf(cockpit: ContractCockpit): unknown[] {
  return cockpit.hooksRead.map((request) => (request.body as HookPayload).hook_event_name);
}

/** Makes a folder of the run's, and gives its path. */
function folder(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Runs the job on a key, and states that the session waits in the
 * terminal on a start-up dialog, as the cockpit and the driver's reading
 * of the real screen tell it: named, or named by none.
 *
 * @returns The screen the dialog is on.
 */
async function waitsOnDialog(
  cockpit: ContractCockpit,
  key: string,
  dialog: StartupDialog | undefined,
): Promise<string> {
  expect(await cockpit.say('say one line', key)).toEqual({ action: 'started', state: 'waiting' });
  const pending = dialog === undefined ? { kind: 'terminal' } : { kind: 'terminal', dialog };
  expect(await cockpit.sessionIn(key, 'waiting')).toMatchObject({ pending: [pending] });
  const screen = await cockpit.terminal(key).screen();
  expect(readScreen(screen)).toEqual(
    dialog === undefined ? { shows: 'dialog' } : { shows: 'dialog', dialog },
  );
  return screen;
}

/** Leaves at a start-up dialog with a key, and gives the session once the cockpit has it ended. */
async function leftAt(cockpit: ContractCockpit, key: string, press: string) {
  await pressOnDialog(cockpit.terminal(key), press, (screen) => screen === undefined);
  return cockpit.sessionIn(key, 'ended');
}

it('37 — A folder inside a trusted folder is trusted; a new folder outside stops at the trust dialog with no hook', async () => {
  const inside = await startContractCockpit({
    directory: ({ workFolder }) => folder(join(workFolder, 'inside', 'deeper')),
  });
  inside.api.script(turn('Inside.'));
  expect(await inside.say('say one line')).toEqual({ action: 'started', state: 'busy' });
  expect(await inside.sessionIn('say', 'idle')).toMatchObject({ lastMessage: 'Inside.' });
  // Started once the first is launched: the server's PATH is the latest cockpit's.
  const outside = await startContractCockpit({
    directory: ({ root }) => folder(join(root, 'elsewhere')),
  });

  const screen = await waitsOnDialog(outside, 'say', 'trust-folder');

  expect(screen).toContain(join(outside.root, 'elsewhere'));
  expect(eventsOf(outside)).toEqual([]);
});

it('68 — The trust dialog\'s selected option is "No, exit"; Enter or Esc on it ends the process with no hook; after "Yes", SessionStart arrives and the prompt passed at launch is submitted', async () => {
  const cockpit = await startContractCockpit({ shim: { leftOutOfRecipe: ['folder-trust'] } });
  cockpit.api.script(turn('Trusted.'));

  for (const [key, press] of [
    ['by-enter', 'Enter'],
    ['by-esc', 'Escape'],
  ] as const) {
    const screen = await waitsOnDialog(cockpit, key, 'trust-folder');
    expect(screen).toContain('Quick safety check: Is this a project you created or one you trust?');
    expect(screen).toContain('❯ No, exit');
    expect(screen).toContain('Yes, I trust this folder');
    expect(await leftAt(cockpit, key, press)).toMatchObject({
      state: 'ended',
      reason: 'declined',
      dialog: 'trust-folder',
    });
  }
  expect(eventsOf(cockpit)).toEqual([]);

  await waitsOnDialog(cockpit, 'by-yes', 'trust-folder');
  await answerYes(cockpit.terminal('by-yes'), TRUST_DIALOG, 'Down');
  const idle = await cockpit.sessionIn('by-yes', 'idle');

  expect(idle).toMatchObject({ lastMessage: 'Trusted.' });
  expect(eventsOf(cockpit)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
  expect(cockpit.hooksRead[1]?.body).toMatchObject({ prompt: 'say one line' });
});

it('69 — A folder reached through a symbolic link is trusted by its resolved path', async () => {
  const cockpit = await startContractCockpit({
    directory: ({ root, workFolder }) => {
      const link = join(root, 'linked-work');
      symlinkSync(workFolder, link);
      return link;
    },
  });
  cockpit.api.script(turn('Through the link.'));

  expect(await cockpit.say('say one line')).toEqual({ action: 'started', state: 'busy' });
  expect(await cockpit.sessionIn('say', 'idle')).toMatchObject({
    lastMessage: 'Through the link.',
  });
  expect(eventsOf(cockpit)[0]).toBe('SessionStart');
});

it("70 — With the onboarding not done, a theme picker, then the security notes, show before any hook; Enter on each, then SessionStart (the login method that follows without a key needs Anthropic's hosts, which no test reaches)", async () => {
  const cockpit = await startContractCockpit({ shim: { leftOutOfRecipe: ['onboarding'] } });
  cockpit.api.script(turn('Onboarded.'));

  const picker = await waitsOnDialog(cockpit, 'say', 'onboarding');
  const session = cockpit.terminal('say');
  await pressOnDialog(session, 'Enter', (screen) => screen?.includes(SECURITY_NOTES) === true);
  const notes = await session.screen();
  const stillWaiting = cockpit.states('say');
  expect(eventsOf(cockpit)).toEqual([]);
  await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(SECURITY_NOTES));
  const idle = await cockpit.sessionIn('say', 'idle');

  expect(picker).toContain(THEME_PICKER);
  expect(readScreen(notes)).toEqual({ shows: 'dialog', dialog: 'onboarding' });
  expect(stillWaiting.at(-1)).toBe('waiting');
  expect(idle).toMatchObject({ lastMessage: 'Onboarded.' });
  expect(eventsOf(cockpit)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
});

it('85 — In bypassPermissions without the person\'s acceptance, a warning shows before any hook, "No, exit" selected, "Yes, I accept" below; Enter or Esc on it ends the process with SessionEnd (reason other) and no SessionStart; after "Yes", SessionStart and the launch prompt', async () => {
  const cockpit = await startContractCockpit({ driver: { permissionMode: 'bypassPermissions' } });
  cockpit.api.script(turn('Accepted.'));

  for (const [key, press] of [
    ['by-enter', 'Enter'],
    ['by-esc', 'Escape'],
  ] as const) {
    const screen = await waitsOnDialog(cockpit, key, 'bypass-permissions');
    expect(screen).toContain(BYPASS_WARNING);
    expect(screen).toContain('By proceeding, you accept all responsibility');
    expect(screen).toContain('❯ No, exit');
    expect(screen).toContain('Yes, I accept');
    expect(eventsOf(cockpit)).toEqual(key === 'by-enter' ? [] : ['SessionEnd']);
    expect(await leftAt(cockpit, key, press)).toMatchObject({
      state: 'ended',
      reason: 'declined',
      dialog: 'bypass-permissions',
    });
  }
  expect(cockpit.hooksRead.map((request) => request.body)).toEqual([
    expect.objectContaining({ hook_event_name: 'SessionEnd', reason: 'other' }),
    expect.objectContaining({ hook_event_name: 'SessionEnd', reason: 'other' }),
  ]);

  await waitsOnDialog(cockpit, 'by-yes', 'bypass-permissions');
  await answerYes(cockpit.terminal('by-yes'), BYPASS_WARNING, 'Down');
  const idle = await cockpit.sessionIn('by-yes', 'idle');

  expect(idle).toMatchObject({ lastMessage: 'Accepted.' });
  expect(eventsOf(cockpit).slice(2)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
});

it('88 — The question about a custom API key, shown when the key is not approved, is a dialog of no name the driver knows: the session waits in the terminal on it, with no hook', async () => {
  const cockpit = await startContractCockpit({ shim: { leftOutOfRecipe: ['key-approval'] } });
  cockpit.api.script(turn('With the key.'));

  const screen = await waitsOnDialog(cockpit, 'say', undefined);
  expect(eventsOf(cockpit)).toEqual([]);
  await answerYes(cockpit.terminal('say'), KEY_QUESTION, 'Up');
  const idle = await cockpit.sessionIn('say', 'idle');

  expect(screen).toContain(KEY_QUESTION);
  expect(screen).toContain('❯ No (recommended)');
  expect(idle).toMatchObject({ lastMessage: 'With the key.' });
  expect(eventsOf(cockpit)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
});
