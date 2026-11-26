import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { eventually } from '../support/eventually.ts';
// The markers the fake agent plays are the ones the real agent is held to here.
import { INTERRUPTED, INTERRUPTED_FOR_TOOL_USE } from '../support/fake-agent/transcript.ts';
import { heldTurn, toolUse, turn } from '../support/fake-api/index.ts';
import type { AgentSession } from '../support/real-agent/runner.ts';
import { type ContractAgent, endSession, startContractAgent, userTexts } from './harness.ts';

/** "At once", for a marker: a wide margin over the few tens of milliseconds the agent takes. */
const AT_ONCE_MS = 2000;

/** The file a running tool call leaves, for the test to know the tool runs. */
const TOOL_STARTED = 'tool-started';

/**
 * A command that runs until it is interrupted. `timeout` ends it by itself
 * should a failed test leave it behind.
 */
const RUNS_UNTIL_INTERRUPTED = `touch ${TOOL_STARTED}; timeout 30 tail -f /dev/null`;

/**
 * Presses Esc in a session that is busy, and checks what follows: the marker
 * in the transcript at once, and no hook from then to the session's end but
 * the end's own.
 */
async function expectInterruption(
  agent: ContractAgent,
  session: AgentSession,
  marker: string,
): Promise<void> {
  const hooksBefore = agent.hooks.events();
  const pressedAt = Date.now();

  await session.press('Escape');

  const recorded = await eventually(() => {
    const found = userTexts(session).find((text) => text.text === marker);
    if (found === undefined) throw new Error(`The transcript holds no "${marker}" yet.`);
    return found;
  });
  expect(recorded.recordedAt - pressedAt).toBeLessThan(AT_ONCE_MS);
  // Once the agent's process is gone, every hook it would have sent has arrived.
  await endSession(session, 'SIGTERM');
  expect(agent.hooks.events().filter((event) => event !== 'SessionEnd')).toEqual(hooksBefore);
}

/** Interrupts a turn while the model's answer is awaited, after a tool call so that the turn has produced something. */
async function interruptWhileGenerating(): Promise<void> {
  const agent = await startContractAgent();
  agent.api.script(turn('Checking.', toolUse('Bash', { command: 'true' })), heldTurn());
  const session = await agent.startNew({ prompt: 'check, then think' });
  await agent.api.heldRequest();

  await expectInterruption(agent, session, INTERRUPTED);

  expect(agent.hooks.events()).not.toContain('Stop');
}

async function interruptWhileAToolRuns(): Promise<void> {
  const agent = await startContractAgent();
  agent.api.script(turn('Waiting.', toolUse('Bash', { command: RUNS_UNTIL_INTERRUPTED })));
  const session = await agent.startNew({ prompt: 'wait' });
  await agent.hook('PreToolUse');
  await eventually(() => expect(existsSync(join(agent.workFolder, TOOL_STARTED))).toBe(true));

  await expectInterruption(agent, session, INTERRUPTED_FOR_TOOL_USE);

  const events = agent.hooks.events();
  expect(events).not.toContain('PostToolUse');
  expect(events).not.toContain('Stop');
}

it('6 — Esc while the agent generates or runs a tool fires no hook; the transcript records an interruption marker at once', async () => {
  await Promise.all([interruptWhileGenerating(), interruptWhileAToolRuns()]);
});
