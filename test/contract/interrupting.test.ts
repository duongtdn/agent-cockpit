import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// The markers the fake agent plays are the ones the real agent is held to here.
import { INTERRUPTED, INTERRUPTED_FOR_TOOL_USE } from '../support/fake-agent/transcript.ts';
import { heldTurn, toolUse, turn } from '../support/fake-api/index.ts';
import type { AgentSession } from '../support/real-agent/runner.ts';
import { type ContractAgent, startContractAgent, userTexts } from './harness.ts';

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
  await session.type(NEXT_PROMPT);
  await session.press('Enter');
  const next = await agent.hook('UserPromptSubmit');
  expect(next.payload.prompt).toBe(NEXT_PROMPT);
  expect(hooksSince()).toEqual(['UserPromptSubmit']);
  const stop = await agent.hook('Stop');
  expect(stop.payload.last_assistant_message).toBe('Going on.');
  expect(hooksSince()).toEqual(['UserPromptSubmit', 'Stop']);
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
  const held = await agent.api.heldRequest();

  await expectInterruption(agent, session, { prompt: 'check, then think', marker: INTERRUPTED });

  expect(await held.ended).toBe('client-gone');
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

  expect(agent.hooks.events()).not.toContain('PostToolUse');
}

it('6 — Esc while the agent generates or runs a tool fires no hook; the transcript records an interruption marker at once', async () => {
  await Promise.all([interruptWhileGenerating(), interruptWhileAToolRuns()]);
});
