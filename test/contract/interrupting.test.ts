import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { DriverEvent } from '../../src/server/driver.ts';
import { eventually } from '../support/eventually.ts';
import { heldTurn, TEXT_WRITTEN, toolUse, turn } from '../support/fake-api/index.ts';
import type { AgentSession } from '../support/real-agent/runner.ts';
import { type Moment, SAID_KEY, sessionAfter, startContractCockpit } from './cockpit-harness.ts';
import {
  type ContractAgent,
  INTERRUPTED,
  INTERRUPTED_FOR_TOOL_USE,
  startContractAgent,
  submitPrompt,
  userTexts,
} from './harness.ts';

/** The file a running tool call leaves, for the test to know the tool runs. */
const TOOL_STARTED = 'tool-started';

/**
 * A command that runs until it is interrupted. `timeout` ends it by itself
 * should a failed test leave it behind.
 */
const RUNS_UNTIL_INTERRUPTED = `touch ${TOOL_STARTED}; timeout 30 tail -f /dev/null`;

/** The prompt given once a turn was interrupted, and the scripted answer that ends its turn. */
const NEXT_PROMPT = 'go on';
const NEXT_ANSWER = turn('Going on.');
/**
 * Every hook of the turn that answers the next prompt: the prompt, its
 * answer shown, the end. With every event registered, these alone since
 * the Esc mean the interruption fired none.
 */
const NEXT_TURN_HOOKS = ['UserPromptSubmit', 'MessageDisplay', 'Stop'];

/**
 * Presses Esc in a session that is busy with a prompt, and checks what
 * follows. "At once" is held without a clock: the marker must be in the
 * transcript while nothing else is done to the session, so the interruption
 * alone records it — the agent writes its transcript a moment behind its
 * hooks and requests, so none of them marks the instant. The next prompt is
 * then the barrier: a hook of the interrupted turn would come before its own.
 */
async function expectInterruption(
  agent: ContractAgent,
  session: AgentSession,
  interrupted: { readonly prompt: string; readonly marker: string },
): Promise<void> {
  const hooksBefore = agent.hooks.events();
  const hooksSince = () => agent.hooks.events().slice(hooksBefore.length);

  await session.press('Escape');

  await agent.eventually(() => expect(userTexts(session)).toContain(interrupted.marker));
  await submitPrompt(agent, session, NEXT_PROMPT);
  expect(hooksSince()).toEqual(['UserPromptSubmit']);
  const stop = await agent.hook('Stop');
  expect(stop.payload.last_assistant_message).toBe('Going on.');
  expect(hooksSince()).toEqual(NEXT_TURN_HOOKS);
  await agent.eventually(() =>
    expect(userTexts(session)).toEqual([interrupted.prompt, interrupted.marker, NEXT_PROMPT]),
  );
}

/** Interrupts a turn while the model's answer is awaited, after a tool call so that the turn has produced something. */
async function interruptWhileGenerating(): Promise<void> {
  const agent = await startContractAgent();
  agent.api.script(
    turn('Checking.', toolUse('Bash', { command: 'true' })),
    heldTurn(),
    NEXT_ANSWER,
  );
  const session = await agent.startNew({ prompt: 'check, then think' });
  await agent.hook('UserPromptSubmit');
  const held = await agent.waitFor('the request the API holds', agent.api.heldRequest());

  await expectInterruption(agent, session, { prompt: 'check, then think', marker: INTERRUPTED });

  expect(await agent.waitFor('the held request to end', held.ended)).toBe('client-gone');
}

async function interruptWhileAToolRuns(): Promise<void> {
  const agent = await startContractAgent();
  agent.api.script(
    turn('Waiting.', toolUse('Bash', { command: RUNS_UNTIL_INTERRUPTED })),
    NEXT_ANSWER,
  );
  const session = await agent.startNew({ prompt: 'wait' });
  await agent.hook('UserPromptSubmit');
  await agent.hook('PreToolUse');
  await agent.eventually(() => expect(existsSync(join(agent.workFolder, TOOL_STARTED))).toBe(true));

  await expectInterruption(agent, session, { prompt: 'wait', marker: INTERRUPTED_FOR_TOOL_USE });
}

it('6 — Esc while the agent generates or runs a tool fires no hook; the transcript records an interruption marker at once', async () => {
  await Promise.all([interruptWhileGenerating(), interruptWhileAToolRuns()]);
});

it('22 — Esc while the agent writes: the transcript records [Request interrupted by user] at once and no hook fires; the driver reads the marker, and the session is idle until the next prompt', async () => {
  const cockpit = await startContractCockpit();
  // Held once its text is written: the agent is writing its answer.
  cockpit.api.script(
    heldTurn(turn('Thinking it over'), { afterEvents: TEXT_WRITTEN }),
    NEXT_ANSWER,
  );

  expect(await cockpit.say('think')).toEqual({ action: 'started', state: 'busy' });
  const held = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  // The agent shows a text once its block ends; while it streams, the tokens it took.
  await eventually(async () => expect(await session.screen()).toMatch(/↓ \d+ tokens/u));
  const from = cockpit.timeline.length;
  await session.press('Escape');
  await eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
  const idle = await sessionAfter(cockpit, 'idle', from);
  const hooksOfTheEsc = cockpit.timeline.slice(from).filter((moment) => 'hook' in moment);
  await cockpit.submitInTerminal(SAID_KEY, NEXT_PROMPT);
  const taken = cockpit.timeline.findIndex(
    (moment: Moment) => 'hook' in moment && moment.hook.prompt === NEXT_PROMPT,
  );
  const answered = await sessionAfter(cockpit, 'idle', taken);

  expect(await held.ended).toBe('client-gone');
  expect(hooksOfTheEsc).toEqual([]);
  expect(idle).toMatchObject({ state: 'idle' });
  expect(answered).toMatchObject({ state: 'idle', lastMessage: 'Going on.' });
  // The agent writes its transcript a moment behind its hooks: the prompt may follow the Stop.
  await eventually(() => expect(userTexts(session)).toEqual(['think', INTERRUPTED, NEXT_PROMPT]));
});

it('95 — the interruption marker carries the time the agent recorded it, earlier than the next prompt is taken: an Esc, then a prompt at once, leave the new turn busy, whenever the driver reads the marker', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(
    heldTurn(turn('Thinking it over'), { afterEvents: TEXT_WRITTEN }),
    heldTurn(NEXT_ANSWER),
  );

  await cockpit.say('think');
  const first = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  await eventually(async () => expect(await session.screen()).toMatch(/↓ \d+ tokens|^●/mu));
  // Typed while the turn runs, submitted as soon as the Esc is recorded: often within one read
  // of the transcript. An Enter pressed with the Esc would be read with it as one key.
  await session.type(NEXT_PROMPT);
  await session.press('Escape');
  await eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
  await cockpit.submitInputBoxInTerminal(SAID_KEY, NEXT_PROMPT);
  const second = await cockpit.api.heldRequest(2);
  const taken = cockpit.timeline.findIndex(
    (moment: Moment) => 'hook' in moment && moment.hook.prompt === NEXT_PROMPT,
  );
  const told = await eventually(() => {
    const moment = cockpit.timeline.find(
      (each: Moment) => 'told' in each && each.told.some((event) => event.type === 'interrupted'),
    );
    expect(moment).toBeDefined();
    return moment as { readonly told: readonly DriverEvent[] };
  });
  const statesOfTheNewTurn = cockpit.timeline
    .slice(taken)
    .flatMap((moment) => ('session' in moment ? [moment.session.state] : []));
  const busyNow = cockpit.cockpit.sessions.list().find((listed) => listed.key === SAID_KEY);
  second.release();
  const answered = await sessionAfter(cockpit, 'idle', taken);

  expect(await first.ended).toBe('client-gone');
  // The agent writes its transcript a moment behind its hooks: the prompt may follow the Stop.
  await eventually(() => expect(userTexts(session)).toEqual(['think', INTERRUPTED, NEXT_PROMPT]));
  expect(told.told).toEqual([{ type: 'interrupted', at: expect.any(String) }]);
  expect(statesOfTheNewTurn).not.toContain('idle');
  expect(busyNow?.state).toBe('busy');
  expect(answered).toMatchObject({ state: 'idle', lastMessage: 'Going on.' });
});
