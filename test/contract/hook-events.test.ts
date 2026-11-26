import { expect, it } from 'vitest';
import { HOOK_EVENTS } from '../support/hooks/hook-receiver.ts';
import { pinnedAgentHookEvents } from '../support/real-agent/binary.ts';

it('the hook receiver registers every hook event the pinned agent has, so that "no hook" means none', () => {
  expect([...HOOK_EVENTS].sort()).toEqual(pinnedAgentHookEvents().sort());
});
