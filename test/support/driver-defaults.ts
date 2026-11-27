import type { Driver } from '../../src/server/driver.ts';

/**
 * The parts of a driver that a test double's tests do not exercise: no
 * agent found, every part and environment fitting, a confined network, a screen that tells
 * nothing and no sign on it, nothing told outside the hooks, no input box (nothing typed), every first prompt
 * fitting the launch, the same settings for every part, SIGTERM to end. A double spreads them, then gives what its tests rest on.
 */
export const DRIVER_DEFAULTS: Pick<
  Driver,
  | 'testedRange'
  | 'agentVersion'
  | 'checkPart'
  | 'environmentIssues'
  | 'networkOf'
  | 'readScreen'
  | 'screenStateSigns'
  | 'follow'
  | 'readInputBox'
  | 'typePrompt'
  | 'promptFitsLaunch'
  | 'launchSettings'
  | 'ending'
> = {
  testedRange: { oldest: '0.0.0', newest: '0.0.0' },
  agentVersion: async () => ({ found: false, command: 'claude' }),
  checkPart: () => [],
  environmentIssues: async () => [],
  networkOf: () => ({ reach: 'confined' }),
  readScreen: () => ({ shows: 'nothing' }),
  screenStateSigns: { launchPanelClosed: () => false },
  follow: () => () => {},
  readInputBox: () => undefined,
  typePrompt: async () => 'not-taken',
  promptFitsLaunch: () => true,
  launchSettings: () => ({}),
  ending: { signal: 'SIGTERM', boundMs: 1_000 },
};
