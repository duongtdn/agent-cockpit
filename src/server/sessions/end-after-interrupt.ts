import { isCockpitError } from '../../shared/cockpit-error.js';
import type { BackgroundTask, EndResult, InterruptResult, Session } from '../../shared/session.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import { wrongState } from './refusals.js';
import { interruptionOf } from './turn-interrupt.js';

/** What an end that stops the session's turn first works with: the session, as the sessions core keeps it. */
export interface EndingSession {
  /** The session as it is now: `undefined` when there is none. */
  session(): Session | undefined;
  /**
   * Whether an end is under way already: the cockpit ending the session,
   * or its going from the host. It is joined, nothing interrupted.
   */
  hasEndUnderWay(): boolean;
  /** Interrupts the session's turn, as the core's interrupt does. */
  interrupt(): Promise<InterruptResult>;
  /**
   * Ends the session as the core's end does, or joins the end under way,
   * and gives the background tasks known as its process went.
   */
  end(): Promise<readonly BackgroundTask[]>;
  /**
   * Waits for the end under way, and gives the background tasks known as
   * the process went: none when that end left the session live, its kill
   * failed.
   */
  join(): Promise<readonly BackgroundTask[]>;
}

/**
 * Ends a session as an app asks, by what it is:
 *
 * | Session | End |
 * |---|---|
 * | none, `ended` | Nothing to end. |
 * | `starting` | Refused. |
 * | `idle`, `waiting` in the terminal only | Ended at once: no turn runs, and no key is pressed into a dialog the cockpit never answers. |
 * | `busy`, `waiting` on anything else | Its turn interrupted first, then ended, whether or not the interrupt was confirmed: the person asked to end it. |
 * | being ended already | That end joined; one that left the session live, its kill failed, is followed by this end, by the session's state then, as above. |
 *
 * @param target - The session.
 * @returns `ended` once the session's process is gone, with the background
 * tasks stopped with it; `nothing-to-end` with the session's state, none
 * when there is no session.
 * @throws `CockpitError` `wrong-state` on a `starting` session. What the
 * end throws. What the interrupt throws but its being unconfirmed and the
 * host's failure as the keys are pressed: the close's refusal among them.
 */
export async function endAfterInterrupt(target: EndingSession): Promise<EndResult> {
  const session = target.session();
  if (session === undefined) return { action: 'nothing-to-end' };
  if (session.state === 'ended') return { action: 'nothing-to-end', state: 'ended' };
  return { action: 'ended', stoppedTasks: await endLive(target, session) };
}

/** Ends a session not yet ended, by its state, as {@link endAfterInterrupt}'s table says. */
async function endLive(
  target: EndingSession,
  session: Session,
): Promise<readonly BackgroundTask[]> {
  const interruption = interruptionOf(session);
  if (interruption === 'refused') throw wrongState(session);
  if (target.hasEndUnderWay()) {
    const stopped = await target.join();
    const now = target.session();
    return now === undefined || now.state === 'ended' ? stopped : endLive(target, now);
  }
  if (interruption === 'stop-the-turn') await interruptAnyway(target);
  return target.end();
}

/** Interrupts the session's turn; an interrupt that cannot be confirmed does not keep the end from going on. */
async function interruptAnyway(target: EndingSession): Promise<void> {
  try {
    await target.interrupt();
  } catch (error) {
    if (isCockpitError(error, 'interrupt-unconfirmed') || error instanceof SessionHostError) return;
    throw error;
  }
}
