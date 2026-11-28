import { expect, it } from 'vitest';
import { readScreen } from '../../src/claude-code/screen-reading.ts';
import { heldTurn, TEXT_WRITTEN, turn } from '../support/fake-api/index.ts';
import { PATIENCE } from '../support/patience.ts';
import type { AgentSession } from '../support/real-agent/runner.ts';
import {
  type ContractAgent,
  conversationTexts,
  startContractAgent,
  submitPrompt,
  userTexts,
} from './harness.ts';

/** A session the agent exits from by itself tells its end: the receiver would hear a SessionEnd. */
async function exitAndHearTheEnd(): Promise<void> {
  const agent = await startContractAgent();
  const session = await agent.startNew();
  await agent.hook('SessionStart');

  await agent.end(session, 'SIGTERM');

  expect(await session.isLive()).toBe(false);
  expect((await agent.hook('SessionEnd')).payload.session_id).toBe(session.id);
}

async function killAndHearNothing(): Promise<void> {
  const agent = await startContractAgent();
  const session = await agent.startNew();
  await agent.hook('SessionStart');

  await agent.end(session, 'SIGKILL');

  expect(await session.isLive()).toBe(false);
  // A killed process sends nothing more: what it sent has arrived.
  expect(agent.hooks.events()).toEqual(['SessionStart']);
}

it('8 — When Claude Code exits, the tmux session is gone; kill -9 sends no SessionEnd', async () => {
  await Promise.all([exitAndHearTheEnd(), killAndHearNothing()]);
});

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends SIGTERM to a session's agent, and states that it ends within
 * seconds: its tmux session goes, and its process has exited.
 */
async function terminateWithinSeconds(agent: ContractAgent, session: AgentSession): Promise<void> {
  const processId = await session.processId();
  const gone = agent.exits(session);
  const signalled = Date.now();
  process.kill(processId, 'SIGTERM');
  await gone;
  // tmux reaps the pane's process and removes the session within a moment of each other, in either order.
  await agent.eventually(() => expect(isRunning(processId)).toBe(false));
  expect(Date.now() - signalled).toBeLessThan(PATIENCE.exit);
}

/** Gives the texts of a request among the ones awaited, in the order the request carries them. */
function carried(texts: readonly string[], awaited: readonly string[]): string[] {
  return texts.filter((text) => awaited.includes(text));
}

/** Resumes a conversation, submits a prompt, and gives the texts the request of its turn carries. */
async function resumedConversation(
  agent: ContractAgent,
  ended: AgentSession,
  prompt: string,
): Promise<string[]> {
  const session = await agent.resume(ended.id);
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, prompt);
  await agent.hook('Stop');
  return conversationTexts(await agent.api.conversationRequest(2));
}

const REMEMBER = 'Remember the word heron.';
const REMEMBERED = 'Noted: heron.';
const ASKED_AFTER = 'Which word was it?';

async function terminateIdle(): Promise<void> {
  const agent = await startContractAgent();
  agent.api.script(turn(REMEMBERED), turn('Heron.'));
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, REMEMBER);
  await agent.hook('Stop');
  // Idle on screen too: the spinner's row stays a moment past the Stop.
  await agent.eventually(async () =>
    expect(readScreen(await session.screen())).toEqual({ shows: 'input-box' }),
  );

  await terminateWithinSeconds(agent, session);
  const texts = await resumedConversation(agent, session, ASKED_AFTER);

  expect(carried(texts, [REMEMBER, REMEMBERED, ASKED_AFTER])).toEqual([
    REMEMBER,
    REMEMBERED,
    ASKED_AFTER,
  ]);
}

async function terminateWhileATurnIsHeld(): Promise<void> {
  const agent = await startContractAgent();
  const unanswered = 'Think it over.';
  agent.api.script(heldTurn(), turn('Answered.'));
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, unanswered);
  const held = await agent.waitFor('the request the API holds', agent.api.heldRequest());

  await terminateWithinSeconds(agent, session);
  const heldEnded = await agent.waitFor('the held request to end', held.ended);
  const texts = await resumedConversation(agent, session, ASKED_AFTER);

  expect(heldEnded).toBe('client-gone');
  expect(carried(texts, [unanswered, ASKED_AFTER])).toEqual([unanswered, ASKED_AFTER]);
}

it('30 — SIGTERM ends Claude Code within seconds, idle or with a turn held at the API: its tmux session goes and its process exits; --resume keeps the conversation', async () => {
  await Promise.all([terminateIdle(), terminateWhileATurnIsHeld()]);
});

it('32 — SIGTERM mid-turn, the answer partly written: the transcript keeps the prompt, not the partial answer, and records no interruption marker', async () => {
  const agent = await startContractAgent();
  const prompt = 'Write an essay.';
  const partial = 'The essay begins here';
  // Held once its text is written: the agent is writing its answer.
  agent.api.script(heldTurn(turn(partial), { afterEvents: TEXT_WRITTEN }));
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, prompt);
  await agent.waitFor('the request the API holds', agent.api.heldRequest());
  // The agent shows a text once its block ends; while it streams, the tokens it took.
  await agent.eventually(async () => expect(await session.screen()).toMatch(/↓ \d+ tokens/u));

  await agent.end(session, 'SIGTERM');

  // A process that exited writes nothing more: its transcript is whole.
  expect(userTexts(session)).toEqual([prompt]);
  expect(JSON.stringify(session.transcript())).not.toContain(partial);
});

const TRUST_DIALOG = 'Accessing workspace:';

async function terminateAtTheTrustDialog(): Promise<void> {
  const agent = await startContractAgent({ runner: { leftOutOfRecipe: ['folder-trust'] } });
  const session = await agent.startNew();
  await agent.eventually(async () => expect(await session.screen()).toContain(TRUST_DIALOG));

  await terminateWithinSeconds(agent, session);

  // A process that exited sends nothing more: what it sent has arrived.
  expect(agent.hooks.events()).toEqual([]);
}

async function terminateOnAPanel(command: string): Promise<void> {
  const agent = await startContractAgent();
  const session = await agent.startNew({ prompt: command });
  await agent.hook('SessionStart');
  await agent.eventually(async () =>
    expect(readScreen(await session.screen())).toMatchObject({ shows: 'panel' }),
  );

  await terminateWithinSeconds(agent, session);

  expect((await agent.hook('SessionEnd')).payload.reason).toBe('other');
}

it('129 — SIGTERM while the trust dialog shows ends Claude Code: its tmux session goes, its process exits, and no SessionEnd fires (no hook does); while a launch command\'s panel shows (/config, /help) it ends it too, with SessionEnd of reason "other"', async () => {
  await Promise.all([
    terminateAtTheTrustDialog(),
    terminateOnAPanel('/config'),
    terminateOnAPanel('/help'),
  ]);
});
