import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { eventually } from '../support/eventually.ts';
// The markers the fake agent plays are the ones the real agent is held to here.
import { INTERRUPTED, INTERRUPTED_FOR_TOOL_USE } from '../support/fake-agent/transcript.ts';
import { heldTurn, TEXT_WRITTEN, toolUse, turn } from '../support/fake-api/index.ts';
import type { AgentSession } from '../support/real-agent/runner.ts';
import { type Moment, SAID_KEY, sessionAfter, startContractCockpit } from './cockpit-harness.ts';
import { type ContractAgent, startContractAgent, submitPrompt, userTexts } from './harness.ts';

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
  expect(userTexts(session)).toEqual(['think', INTERRUPTED, NEXT_PROMPT]);
});
