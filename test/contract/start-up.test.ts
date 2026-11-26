import { expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { eventually } from '../support/eventually.ts';
import { turn } from '../support/fake-api/index.ts';
import { type HookPayload, SAID_KEY, startContractCockpit } from './cockpit-harness.ts';
import { pressOnDialog } from './dialog-keys.ts';
import { conversationTexts } from './harness.ts';

/**
 * How a start goes that no dialog stops, but that tells the cockpit less
 * than a normal one, met by a cockpit with the driver's own launch.
 */

const driver = claudeCode();

/**
 * How long the agent may take to show its first screen: no hook tells it
 * here. Under a full suite's load it has taken up to 4 s (0.4 s alone).
 */
const START_PATIENCE_MS = 15_000;

it("86 — With every hook off (disableAllHooks in the person's settings), the agent shows its ordinary ready screen, takes the launch prompt and answers it, and fires no hook, SessionStart included", async () => {
  const cockpit = await startContractCockpit({ personsSettings: { disableAllHooks: true } });
  cockpit.api.script(turn('Unheard.'));

  const run = cockpit.say('say one line');
  // One terminal, once the session is launched: each one reads its screen until the session ends.
  const session = await eventually(() => cockpit.terminal(SAID_KEY));
  const screen = await eventually(
    async () => {
      const shown = await session.screen();
      expect(driver.readScreen(shown)).toEqual({ shows: 'ready' });
      return shown;
    },
    undefined,
    START_PATIENCE_MS,
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
