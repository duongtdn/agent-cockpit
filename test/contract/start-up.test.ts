import { expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import type { TranscriptEntry } from '../support/agent-session.ts';
import { eventually } from '../support/eventually.ts';
import { turn } from '../support/fake-api/index.ts';
import { PATIENCE } from '../support/patience.ts';
import { type HookPayload, SAID_KEY, startContractCockpit } from './cockpit-harness.ts';
import { pressOnDialog } from './dialog-keys.ts';
import { conversationTexts } from './harness.ts';

/**
 * How a start goes that no dialog stops, but that tells the cockpit less
 * than a normal one, met by a cockpit with the driver's own launch.
 */

const driver = claudeCode();

/**
 * The agent's first screen is awaited for `PATIENCE.agentStep`: no hook
 * tells it here. Under a full suite's load it has taken up to 4 s (0.4 s alone).
 */

it("86 — With every hook off (disableAllHooks in the person's settings), the agent shows its ordinary ready screen, takes the launch prompt and answers it, and fires no hook, SessionStart included", async () => {
  const cockpit = await startContractCockpit({ personsSettings: { disableAllHooks: true } });
  cockpit.api.script(turn('Unheard.'));

  const run = cockpit.say('say one line');
  // One terminal, once the session is launched: each one reads its screen until the session ends.
  const session = await eventually(() => cockpit.terminal(SAID_KEY));
  const screen = await eventually(
    async () => {
      const shown = await session.screen();
      expect(driver.readScreen(shown)).toEqual({ shows: 'input-box' });
      return shown;
    },
    undefined,
    PATIENCE.agentStep,
  );
  const request = await cockpit.api.conversationRequest(1);

  await expect(run).rejects.toMatchObject({
    code: 'unobservable',
    cause: driver.silentStartCause,
  });
  expect(conversationTexts(request)).toContain('say one line');
  expect(screen).toContain('❯');
  expect(cockpit.hooksRead).toEqual([]);
  expect(await cockpit.sessionIn(SAID_KEY, 'ended')).toMatchObject({ reason: 'unobservable' });
});

it('89 — A local command as the launch prompt (/help) fires SessionStart only, no UserPromptSubmit and no Stop; its panel waits for Esc, after which the input box takes a prompt', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(turn('After the help.'));

  const result = await cockpit.say('/help');
  const session = cockpit.terminal(SAID_KEY);
  const panel = await session.screen();
  const eventsBeforeEsc = cockpit.hooksRead.map(
    (request) => (request.body as HookPayload).hook_event_name,
  );
  await pressOnDialog(session, 'Escape', (screen) => !screen?.includes('Esc to close'));
  const idle = await cockpit.sessionIn(SAID_KEY, 'idle');
  const taken = await cockpit.submitInTerminal(SAID_KEY, 'say one line');
  await eventually(() =>
    expect(cockpit.timeline.at(-1)).toMatchObject({
      session: { state: 'idle', lastMessage: 'After the help.' },
    }),
  );

  expect(result).toEqual({ action: 'started', state: 'waiting' });
  expect(cockpit.states(SAID_KEY).slice(0, 2)).toEqual(['starting', 'waiting']);
  expect(await cockpit.sessionIn(SAID_KEY, 'waiting')).toMatchObject({
    pending: [{ kind: 'terminal' }],
  });
  expect(panel).toContain('Esc to close');
  expect(eventsBeforeEsc).toEqual(['SessionStart']);
  expect(idle.state).toBe('idle');
  expect(taken).toMatchObject({ prompt: 'say one line' });
  // The help is the agent's own: nothing of it reached the API.
  expect(cockpit.api.requests().filter((request) => request.kind === 'conversation')).toHaveLength(
    1,
  );
});

/** The text of a transcript's entry: a `system` entry's own, a `user` message's when it is one text. */
function entryText(entry: TranscriptEntry): string | undefined {
  if (typeof entry.content === 'string') return entry.content;
  const message = entry.message as { content?: unknown } | undefined;
  return typeof message?.content === 'string' ? message.content : undefined;
}

/** The entries a local command's end writes, as the driver reads them: its output, its error, its caveat, an unknown name's. */
const COMMAND_END = /^(?:<local-command-(?:stdout|stderr|caveat)>|Unknown command: )/;

/** The hooks a cockpit read, by event. */
function hookEvents(cockpit: { hooksRead: readonly { body: unknown }[] }): unknown[] {
  return cockpit.hooksRead.map((request) => (request.body as HookPayload).hook_event_name);
}

for (const { prompt, end } of [
  { prompt: '/context', end: /^<local-command-stdout>/ },
  { prompt: '/clear', end: /^<local-command-stdout>/ },
  // Nothing to compact yet.
  { prompt: '/compact', end: /^<local-command-stderr>Error: No messages to compact/ },
  { prompt: '/nosuchcommand', end: /^Unknown command: \/nosuchcommand$/ },
]) {
  it(`121 — A local command as the launch prompt that ends by itself (${prompt}) fires no hook of its own (/clear's SessionEnd and SessionStart of source clear aside) and records its end in the transcript of the conversation the hooks name: <command-name> with <local-command-stdout> or <local-command-stderr>, or the unknown command's entry; the driver reads it there: the run resolves idle`, async () => {
    const cockpit = await startContractCockpit();

    const result = await cockpit.say(prompt);
    const starts = cockpit.hooksRead
      .map((request) => request.body as HookPayload)
      .filter((hook) => hook.hook_event_name === 'SessionStart');
    // The hooks arrive in no set order (a command hook forwards through a process of its own).
    const named = String(
      (prompt === '/clear' ? starts.find((hook) => hook.source === 'clear') : starts[0])
        ?.session_id,
    );
    const transcript = await eventually(() => {
      const entries = cockpit.terminal(SAID_KEY, named).transcript();
      expect(entries.map(entryText).some((text) => text !== undefined && end.test(text))).toBe(
        true,
      );
      return entries;
    });

    expect(result).toEqual({ action: 'started', state: 'idle' });
    expect(cockpit.states(SAID_KEY)).toEqual(['starting', 'idle']);
    expect(hookEvents(cockpit).toSorted()).toEqual(
      prompt === '/clear' ? ['SessionEnd', 'SessionStart', 'SessionStart'] : ['SessionStart'],
    );
    if (prompt === '/clear') expect(named).not.toBe(cockpit.conversationOf(SAID_KEY));
    expect(transcript.some((entry) => entry.promptSource !== undefined)).toBe(false);
    // The command is the agent's own: nothing of it reached the API.
    expect(cockpit.api.requests().filter((request) => request.kind === 'conversation')).toEqual([]);
  });
}

for (const { prompt, panel } of [
  { prompt: '/help', panel: 'help' },
  { prompt: '/cost', panel: 'cost' },
  { prompt: '/status', panel: 'status' },
  { prompt: '/config', panel: 'config' },
  { prompt: '/model', panel: 'model' },
]) {
  it(`122 — A local command as the launch prompt that opens a panel (${prompt}) fires no hook and records no end in the transcript while the panel shows; the driver names the panel, and the session waits in the terminal; Esc closes it: the input box back with no spinner row above it, the driver's sign of the panel's end: idle`, async () => {
    const cockpit = await startContractCockpit();

    const result = await cockpit.say(prompt);
    const session = cockpit.terminal(SAID_KEY);
    const shown = await eventually(async () => {
      const screen = await session.screen();
      expect(driver.readScreen(screen)).toEqual({ shows: 'panel', panel });
      return screen;
    });
    const waiting = await cockpit.sessionIn(SAID_KEY, 'waiting');
    const hooksWhileShown = hookEvents(cockpit);
    const endsWhileShown = session
      .transcript()
      .map(entryText)
      .filter((text) => text !== undefined && COMMAND_END.test(text));
    await pressOnDialog(session, 'Escape', (screen) =>
      screen === undefined ? false : driver.readScreen(screen).shows !== 'panel',
    );
    const idle = await cockpit.sessionIn(SAID_KEY, 'idle');
    const closed = await eventually(async () => {
      const screen = await session.screen();
      expect(driver.screenStateSigns.launchPanelClosed(screen)).toBe(true);
      return screen;
    });

    expect(result).toEqual({ action: 'started', state: 'waiting' });
    expect(waiting).toMatchObject({ pending: [{ kind: 'terminal' }] });
    expect(shown).not.toBe(closed);
    expect(hooksWhileShown).toEqual(['SessionStart']);
    expect(endsWhileShown).toEqual([]);
    expect(idle.state).toBe('idle');
    expect(cockpit.states(SAID_KEY)).toEqual(['starting', 'waiting', 'idle']);
  });
}
