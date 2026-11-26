import { expect, it } from 'vitest';
import { eventually } from '../support/eventually.ts';
import { INTERRUPTED } from '../support/fake-agent/transcript.ts';
import { heldTurn, TEXT_WRITTEN, turn } from '../support/fake-api/index.ts';
import { SAID_KEY, sessionAfter, startContractCockpit } from './cockpit-harness.ts';
import { userTexts } from './harness.ts';

/** A `/clear` typed in a session, met by a cockpit with the driver's own launch and hooks. */

it('93 — /clear starts a new conversation under a new id, which SessionStart (source clear) names; the driver follows it: an Esc in it makes the session idle, and the ended session resumes it', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(
    turn('Before the clear.'),
    // Held once its text is written: the agent is writing its answer.
    heldTurn(turn('Thinking it over'), { afterEvents: TEXT_WRITTEN }),
  );

  await cockpit.say('say one line');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const launched = cockpit.conversationOf(SAID_KEY);
  const cleared = await cockpit.submitInTerminal(SAID_KEY, '/clear', 'SessionStart');
  const conversation = String(cleared.session_id);
  const from = cockpit.timeline.length;
  await cockpit.submitInTerminal(SAID_KEY, 'think');
  const held = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY, conversation);
  // Streamed output shows: the tokens the agent took, or the bullet of the text it writes.
  await eventually(async () => expect(await session.screen()).toMatch(/↓ \d+ tokens|^●/mu));
  await session.press('Escape');
  const idle = await sessionAfter(cockpit, 'idle', from);
  const ended = await cockpit.exitByItself(SAID_KEY, conversation);

  expect(cleared).toMatchObject({ hook_event_name: 'SessionStart', source: 'clear' });
  expect(conversation).not.toBe(launched);
  expect(await held.ended).toBe('client-gone');
  // The new conversation opens on the /clear itself, recorded as user entries of its own.
  expect(userTexts(session).at(1)).toContain('<command-name>/clear</command-name>');
  expect(userTexts(session).slice(-2)).toEqual(['think', INTERRUPTED]);
  expect(idle).toMatchObject({ state: 'idle' });
  expect(cockpit.conversationsFollowed.map((followed) => followed.conversationId)).toEqual([
    launched,
    conversation,
  ]);
  expect(cockpit.askedToResume.map((asked) => asked.conversationId)).toEqual([conversation]);
  expect(ended).toMatchObject({ state: 'ended', reason: 'agent-exit', canResume: true });
});
