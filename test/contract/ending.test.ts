import { expect, it } from 'vitest';
import { startContractAgent } from './harness.ts';

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
