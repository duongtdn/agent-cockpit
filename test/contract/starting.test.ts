import { expect, it } from 'vitest';
import { turn } from '../support/fake-api/index.ts';
import { conversationTexts, endSession, startContractAgent, userTexts } from './harness.ts';

it('1 — SessionStart arrives as a command hook, not as an HTTP hook', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('Hello.'));

  const session = await agent.startNew({ prompt: 'hello' });
  const start = await agent.hook('SessionStart');
  // The turn's HTTP hooks came after the start: an HTTP SessionStart would have come before them.
  const stop = await agent.hook('Stop');

  expect(start.via).toBe('command');
  expect(start.payload).toMatchObject({
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: session.id,
  });
  expect(stop.via).toBe('http');
  expect(
    agent.hooks.received.filter((hook) => hook.event === 'SessionStart').map((hook) => hook.via),
  ).toEqual(['command']);
});

it('2 — A prompt given on the command line is submitted without keys, for a new and a resumed session', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('First answer.'), turn('Second answer.'));

  const session = await agent.startNew({ prompt: 'the prompt of a new session' });
  const first = await agent.hook('UserPromptSubmit');
  await agent.hook('Stop');
  await endSession(session, 'SIGTERM');
  await agent.resume(session.id, { prompt: 'the prompt of a resumed session' });
  const second = await agent.hook('UserPromptSubmit');
  await agent.hook('Stop');

  expect(first.payload.prompt).toBe('the prompt of a new session');
  expect(second.payload.prompt).toBe('the prompt of a resumed session');
  agent.api.assertScriptUsedUp();
});

it('3 — --resume <uuid> keeps the session id and the conversation', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('The earlier answer.'), turn('The later answer.'));
  const session = await agent.startNew({ prompt: 'the earlier prompt' });
  await agent.hook('SessionStart');
  await agent.hook('Stop');
  await endSession(session, 'SIGTERM');

  const resumed = await agent.resume(session.id, { prompt: 'the later prompt' });
  const start = await agent.hook('SessionStart');
  await agent.hook('Stop');

  expect(start.payload).toMatchObject({ source: 'resume', session_id: session.id });
  // The agent adds texts of its own around what was said; the conversation is these, in order.
  const said = ['the earlier prompt', 'The earlier answer.', 'the later prompt'];
  const texts = conversationTexts(await agent.api.conversationRequest(2));
  expect(texts.filter((text) => said.includes(text))).toEqual(said);
  expect(userTexts(resumed).map((recorded) => recorded.text)).toEqual([
    'the earlier prompt',
    'the later prompt',
  ]);
});
