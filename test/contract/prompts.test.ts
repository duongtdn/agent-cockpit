import { expect, it } from 'vitest';
import { eventually } from '../support/eventually.ts';
import { turn } from '../support/fake-api/index.ts';
import { inputBoxText, startContractAgent } from './harness.ts';

it('4 — Keys typed before SessionStart lose their Enter; keys typed after it are submitted', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('First answer.'), turn('Second answer.'));

  const session = await agent.startNew();
  await session.type('typed too early');
  await session.press('Enter');
  const hooksWhenTyped = agent.hooks.events();
  await agent.hook('SessionStart');

  // The text is in the input box and stays there: its Enter submitted nothing.
  await eventually(async () =>
    expect(inputBoxText(await session.screen())).toBe('typed too early'),
  );
  expect(hooksWhenTyped).toEqual([]);
  expect(agent.hooks.events()).toEqual(['SessionStart']);

  await session.press('Enter');
  const early = await agent.hook('UserPromptSubmit');
  await agent.hook('Stop');
  await session.type('typed after the start');
  await session.press('Enter');
  const late = await agent.hook('UserPromptSubmit');
  await agent.hook('Stop');

  expect(early.payload.prompt).toBe('typed too early');
  expect(late.payload.prompt).toBe('typed after the start');
  expect(agent.hooks.events().filter((event) => event === 'UserPromptSubmit')).toHaveLength(2);
});

it('5 — A submitted prompt fires UserPromptSubmit', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('First answer.'), turn('Second answer.'));

  const session = await agent.startNew({ prompt: 'given on the command line' });
  const given = await agent.hook('UserPromptSubmit');
  await agent.hook('Stop');
  await session.type('typed into the terminal');
  await session.press('Enter');
  const typed = await agent.hook('UserPromptSubmit');
  await agent.hook('Stop');

  for (const [hook, prompt] of [
    [given, 'given on the command line'],
    [typed, 'typed into the terminal'],
  ] as const) {
    expect(hook.via).toBe('http');
    expect(hook.payload).toMatchObject({
      hook_event_name: 'UserPromptSubmit',
      session_id: session.id,
      prompt,
    });
  }
});

it('7 — A normal turn end fires Stop with last_assistant_message', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('The answer is 42.'));

  const session = await agent.startNew({ prompt: 'what is the answer?' });
  const stop = await agent.hook('Stop');

  expect(stop.via).toBe('http');
  expect(stop.payload).toMatchObject({
    hook_event_name: 'Stop',
    session_id: session.id,
    last_assistant_message: 'The answer is 42.',
  });
});
