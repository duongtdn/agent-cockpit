import type { Driver } from '../../src/server/driver.ts';

/**
 * The parts of a driver that a test double's tests do not exercise: no
 * agent found, every part and environment fitting, a confined network, a screen that tells
 * nothing, nothing told outside the hooks. A double spreads them, then gives what its tests rest on.
 */
export const DRIVER_DEFAULTS: Pick<
  Driver,
  | 'testedRange'
  | 'agentVersion'
  | 'checkPart'
  | 'environmentIssues'
  | 'networkOf'
  | 'readScreen'
  | 'follow'
> = {
  testedRange: { oldest: '0.0.0', newest: '0.0.0' },
  agentVersion: async () => ({ found: false, command: 'claude' }),
  checkPart: () => [],
  environmentIssues: async () => [],
  networkOf: () => ({ reach: 'confined' }),
  readScreen: () => ({ shows: 'nothing' }),
  follow: () => () => {},
};
