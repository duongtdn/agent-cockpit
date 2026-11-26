import { expect, it } from 'vitest';
import { turn } from '../support/fake-api/index.ts';
import {
  type ContractAgent,
  inputBoxText,
  startContractAgent,
  submitInputBox,
  submitPrompt,
} from './harness.ts';

/** Typed once every key before it was read, it shows where the early keys left the input box. */
const BARRIER = '.';

it('4 — Keys typed before SessionStart keep their text, not surely their Enter; keys typed after it are submitted', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('First answer.'), turn('Second answer.'));

  const session = await agent.startNew();
  await session.type('typed too early');
  await session.press('Enter');
  const hooksWhenTyped = agent.hooks.events();
  await agent.hook('SessionStart');

  // The input takes keys a little before SessionStart reaches the receiver, more so under load,
  // so the early Enter is lost or submits: what holds is that the text is not lost.
  await session.type(BARRIER);
  const outcome = await agent.eventually(async () =>
    earlyKeysOutcome(await session.screen(), agent),
  );
  expect(hooksWhenTyped).toEqual([]);

  if (outcome === 'kept') {
    expect(agent.hooks.events()).toEqual(['SessionStart']);
    const { hook } = await submitInputBox(agent, session, (box) => KEPT_IN_THE_BOX.test(box));
    expect(hook.payload.prompt).toMatch(KEPT_IN_THE_BOX);
  } else {
    const submitted = await agent.hook('UserPromptSubmit');
    expect(submitted.payload.prompt).toBe('typed too early');
    await session.press('BSpace');
    await agent.eventually(async () => expect(inputBoxText(await session.screen())).toBe(''));
  }
  await agent.hook('Stop');

  const { hook: late } = await submitPrompt(agent, session, 'typed after the start');
  await agent.hook('Stop');

  expect(late.payload.prompt).toBe('typed after the start');
  expect(agent.hooks.events().filter((event) => event === 'UserPromptSubmit')).toHaveLength(2);
});

/** The early text, then the barrier, maybe on a line of its own: where the early Enter was lost, or became a line break. */
const KEPT_IN_THE_BOX = /^typed too early\s*\.$/;

/** Where the early keys went: still in the box, or submitted, once. */
type EarlyKeysOutcome = 'kept' | 'submitted';

/**
 * Tells where the early keys went, once the barrier shows.
 *
 * @throws Error until the barrier shows the early keys either in the box,
 * with no submit, or submitted once, the barrier alone in the box.
 */
function earlyKeysOutcome(screen: string, agent: ContractAgent): EarlyKeysOutcome {
  const box = inputBoxText(screen) ?? '';
  const submits = agent.hooks.received.filter((hook) => hook.event === 'UserPromptSubmit');
  if (submits.length === 0 && KEPT_IN_THE_BOX.test(box)) return 'kept';
  if (submits.length === 1 && box === BARRIER) return 'submitted';
  throw new Error(
    `The early keys are neither in the box nor submitted once: the box holds ${JSON.stringify(box)}, ${submits.length} UserPromptSubmit came.`,
  );
}

it('5 — A submitted prompt fires UserPromptSubmit', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('First answer.'), turn('Second answer.'));

  const session = await agent.startNew({ prompt: 'given on the command line' });
  const given = await agent.hook('UserPromptSubmit');
  await agent.hook('Stop');
  const { hook: typed } = await submitPrompt(agent, session, 'typed into the terminal');
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
