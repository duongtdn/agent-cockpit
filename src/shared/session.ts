/**
 * The state of a unit of work's session: `starting` (the agent is launching),
 * `idle` (it waits for a prompt), `busy` (it works on a turn), `waiting` (it
 * waits for a person: an ask, a channel request or something in the
 * terminal), `ended` (no agent runs).
 */
export type SessionState = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended';

/**
 * A dialog the agent shows in its terminal before it takes a first prompt:
 * trusting the folder, confirming a mode that skips permissions, the first
 * run's choices, or logging in.
 */
export type StartupDialog = 'trust-folder' | 'bypass-permissions' | 'onboarding' | 'login';

/**
 * One thing a `waiting` session waits for: an ask of the agent's (`ask`), a
 * channel request (`request`), or something only the terminal can answer
 * (`terminal`).
 */
export interface Pending {
  /** What kind of thing waits. */
  readonly kind: 'ask' | 'request' | 'terminal';
  /** The id of the ask or the channel request, to answer it by. */
  readonly id?: string;
  /** The start-up dialog shown in the terminal, when it is a known one. */
  readonly dialog?: StartupDialog;
}
