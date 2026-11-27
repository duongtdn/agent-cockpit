import { CockpitError } from '../../shared/cockpit-error.js';
import type { Session } from '../../shared/session.js';
import type { TypingOutcome } from '../driver.js';

/**
 * The refusal of an operation the session's state does not allow: on a
 * `waiting` session, with everything it waits for.
 *
 * @param session - The session as it is.
 * @param detail - A sentence the message ends with: what the refused operation left.
 * @returns The error.
 */
export function wrongState(session: Session, detail?: string): CockpitError<'wrong-state'> {
  const message = `The session ${session.key} is ${session.state}.`;
  return new CockpitError('wrong-state', detail === undefined ? message : `${message} ${detail}`, {
    key: session.key,
    state: session.state,
    ...(session.state === 'waiting' ? { pending: session.pending } : {}),
  });
}

/**
 * Why a prompt typed was not taken: the agent did not take it, or no input
 * box took it, the message saying where the person's draft is when the
 * driver could not put it back.
 *
 * @param outcome - What the typing came to.
 * @param session - The session as it is.
 * @returns The error.
 */
export function typingFailure(
  outcome: Exclude<TypingOutcome, 'taken'>,
  session: Session,
): CockpitError<'wrong-state' | 'prompt-not-taken'> {
  if (outcome === 'no-input-box') return wrongState(session);
  if (outcome !== 'not-taken') return wrongState(session, outcome.draftLeft);
  return new CockpitError(
    'prompt-not-taken',
    `The session ${session.key} did not take the prompt.`,
    {
      key: session.key,
      state: session.state,
    },
  );
}
