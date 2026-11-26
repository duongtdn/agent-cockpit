import { describe, expect, it, vi } from 'vitest';
import { CANNOT_PLAY_STATUS } from '../support/fake-agent/agent.ts';
import type { Key } from '../support/fake-agent/keys.ts';
import { UNTRUSTED_EXIT_LINES } from '../support/fake-agent/start-up-dialogs.ts';
import { type Played, playFakeAgent, submit } from '../support/played-fake-agent.ts';

const reply = { do: 'reply', text: 'Done.' } as const;

function press(played: Played, ...keys: Key['kind'][]): void {
  for (const kind of keys) played.agent.press({ kind } as Key);
}

async function exited(played: Played, status: number): Promise<void> {
  await vi.waitFor(() => expect(played.exits).toEqual([status]));
}

describe('the fake agent at a start-up dialog', () => {
  it('shows the dialog, its first option selected, and fires no hook while it waits', async () => {
    const played = await playFakeAgent({ script: [], startUpDialogs: ['trust-folder'] });

    expect(played.screen().startUpDialog).toMatchObject({ kind: 'trust-folder', selected: 0 });
    expect(played.fired).toEqual([]);
  });

  it.each([['enter'], ['escape']] as const)(
    'leaves at the trust dialog on %s with no hook, saying why below it (behavior 68)',
    async (key) => {
      const played = await playFakeAgent({ script: [], startUpDialogs: ['trust-folder'] });

      press(played, key);

      await exited(played, 1);
      expect(played.fired).toEqual([]);
      expect(played.answersWritten).toEqual([]);
      expect(played.screen().farewell).toEqual(UNTRUSTED_EXIT_LINES);
    },
  );

  it('starts once the folder is trusted, and writes the answer', async () => {
    const played = await playFakeAgent({ script: [], startUpDialogs: ['trust-folder'] });

    press(played, 'down');
    expect(played.screen().startUpDialog?.selected).toBe(1);
    press(played, 'enter');

    await vi.waitFor(() => expect(played.fired).toEqual(['SessionStart']));
    expect(played.answersWritten).toEqual(['accept trust-folder']);
    expect(played.screen()).toMatchObject({ state: 'idle', startUpDialog: undefined });
  });

  it.each([['enter'], ['escape']] as const)(
    'leaves at the warning of bypassPermissions on %s, with SessionEnd',
    async (key) => {
      const played = await playFakeAgent({
        script: [],
        mode: 'bypassPermissions',
        startUpDialogs: ['bypass-permissions'],
      });

      press(played, key);

      await exited(played, 1);
      expect(played.fired).toEqual(['SessionEnd']);
      expect(played.events[0]?.fields).toEqual({ reason: 'other' });
    },
  );

  it('shows its dialogs one after the other: the trust, then the warning', async () => {
    const played = await playFakeAgent({
      script: [],
      mode: 'bypassPermissions',
      startUpDialogs: ['trust-folder', 'bypass-permissions'],
    });

    press(played, 'down', 'enter');
    await vi.waitFor(() => expect(played.screen().startUpDialog?.kind).toBe('bypass-permissions'));
    press(played, 'down', 'enter');

    await vi.waitFor(() => expect(played.fired).toEqual(['SessionStart']));
    expect(played.answersWritten).toEqual(['accept trust-folder', 'accept bypass-permissions']);
  });

  it('takes the key on Yes to its question', async () => {
    const played = await playFakeAgent({ script: [[reply]], startUpDialogs: ['api-key'] });
    expect(played.screen().startUpDialog?.selected).toBe(1);

    press(played, 'up', 'enter');

    await vi.waitFor(() => expect(played.fired).toEqual(['SessionStart']));
    expect(played.answersWritten).toEqual(['accept api-key']);
  });

  it('declines the key on No, then fails every turn on the login, with no turn of the script', async () => {
    const played = await playFakeAgent({ script: [], startUpDialogs: ['api-key'] });

    press(played, 'enter');
    await vi.waitFor(() => expect(played.fired).toEqual(['SessionStart']));
    submit(played, 'hello');

    await vi.waitFor(() =>
      expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'StopFailure']),
    );
    expect(played.answersWritten).toEqual(['reject-key']);
    expect(played.events.at(-1)?.fields).toMatchObject({
      error: 'authentication_failed',
      last_assistant_message: 'Not logged in · Please run /login',
    });
    expect(played.screen().state).toBe('idle');
  });

  it('fails every turn on the login when the key was declined before', async () => {
    const played = await playFakeAgent({ script: [], keyRejected: true });

    submit(played, 'hello');

    await vi.waitFor(() => expect(played.fired.at(-1)).toBe('StopFailure'));
  });

  it.each([
    ['text', 'trust-folder', ['text']],
    ['Up on the first option', 'trust-folder', ['up']],
    ['Down on the last option', 'trust-folder', ['down', 'down']],
    ['Esc', 'api-key', ['escape']],
  ] as const)(
    'refuses %s on a dialog: what it does was not observed',
    async (_what, dialog, keys) => {
      const played = await playFakeAgent({ script: [], startUpDialogs: [dialog] });

      for (const kind of keys) played.agent.press(kind === 'text' ? { kind, text: 'y' } : { kind });

      await exited(played, CANNOT_PLAY_STATUS);
      expect(played.screen().problem).toMatch(/not observed/);
      expect(played.fired).toEqual([]);
    },
  );
});
