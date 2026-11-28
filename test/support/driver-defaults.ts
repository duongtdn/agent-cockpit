import type { Driver } from '../../src/server/driver.ts';

/**
 * The parts of a driver that a test double's tests do not exercise: no
 * agent found, every part and environment fitting, a confined network, a screen that tells
 * nothing and no sign on it, nothing told outside the hooks, no input box (nothing typed or cleared), every first prompt
 * fitting the launch, the same settings for every part, SIGTERM to end, Esc to interrupt (a held ask by a reply that names it), each answer replied as it is. A double spreads them, then gives what its tests rest on.
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
  | 'clearInputBox'
  | 'promptFitsLaunch'
  | 'launchSettings'
  | 'ending'
  | 'interrupting'
  | 'answerReply'
> = {
  testedRange: { oldest: '0.0.0', newest: '0.0.0' },
  agentVersion: async () => ({ found: false, command: 'claude' }),
  checkPart: () => [],
  environmentIssues: async () => [],
  networkOf: () => ({ reach: 'confined' }),
  readScreen: () => ({ shows: 'nothing' }),
  screenStateSigns: { launchPanelClosed: () => false, promptWithdrawn: () => false },
  follow: () => () => {},
  readInputBox: () => undefined,
  typePrompt: async () => 'not-taken',
  clearInputBox: async () => 'no-input-box',
  promptFitsLaunch: () => true,
  launchSettings: () => ({}),
  ending: { signal: 'SIGTERM', boundMs: 1_000 },
  interrupting: {
    busy: { keys: ['Escape'] },
    appAsk: { reply: { interrupt: true } },
    terminalAsk: { keys: ['Escape'] },
    boundMs: 1_000,
  },
  answerReply: (_ask, answer) => ({ answer }),
};
