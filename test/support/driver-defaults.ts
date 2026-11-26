import type { Driver } from '../../src/server/driver.ts';

/**
 * The parts of a driver that a test double's tests do not exercise: no
 * agent found, every part fitting, a confined network, a screen that tells
 * nothing. A double spreads them, then gives what its tests rest on.
 */
export const DRIVER_DEFAULTS: Pick<
  Driver,
  'testedRange' | 'agentVersion' | 'checkPart' | 'networkOf' | 'readScreen'
> = {
  testedRange: { oldest: '0.0.0', newest: '0.0.0' },
  agentVersion: async () => ({ found: false, command: 'claude' }),
  checkPart: () => [],
  networkOf: () => ({ reach: 'confined' }),
  readScreen: () => ({ shows: 'nothing' }),
};
