import { describe, expect, it } from 'vitest';
import { pressOnDialog } from '../contract/dialog-keys.ts';
import type { AgentSession } from '../support/agent-session.ts';

/**
 * A session whose agent took the first key but acts on it slowly: it is
 * still there when the key is pressed again, and gone by the time the
 * press reaches its terminal.
 */
function sessionLeavingSlowly(): AgentSession & { presses: number } {
  let live = true;
  const session = {
    name: 'slow-1',
    id: 'id',
    presses: 0,
    async press() {
      session.presses += 1;
      if (session.presses === 1) return;
      live = false;
      throw new Error('no server running');
    },
    isLive: async () => live,
    screen: async () => 'a dialog',
    type: async () => {},
    transcript: () => [],
    processId: async () => 1,
    ended: new Promise<never>(() => {}),
  };
  return session;
}

describe('a key pressed on a start-up dialog', () => {
  it('is taken when the session it would leave is gone before the key is pressed again', async () => {
    const session = sessionLeavingSlowly();

    await pressOnDialog(session, 'Enter', (screen) => screen === undefined);

    expect(session.presses).toBe(2);
  });

  it('fails on a press that fails while the session lives', async () => {
    const session = { ...sessionLeavingSlowly(), isLive: async () => true };
    session.press = async () => {
      throw new Error('tmux failed');
    };

    await expect(pressOnDialog(session, 'Enter', () => false)).rejects.toThrow('tmux failed');
  });
});
