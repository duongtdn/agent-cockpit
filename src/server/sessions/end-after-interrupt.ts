import { isCockpitError } from '../../shared/cockpit-error.js';
import type { BackgroundTask, EndResult, InterruptResult, Session } from '../../shared/session.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import { wrongState } from './refusals.js';
import { interruptionOf } from './turn-interrupt.js';

/** What the interrupt an end asks first works with: the session, as the sessions core keeps it. */
export interface InterruptedBeforeEnd {
  /** The session as it is now: `undefined` when there is none. */
  session(): Session | undefined;
  /**
   * Whether an end is under way already: the cockpit ending the session,
   * or its going from the host. It is joined, nothing interrupted.
   */
  hasEndUnderWay(): boolean;
  /** Interrupts the session's turn, as the core's interrupt does. */
  interrupt(): Promise<InterruptResult>;
  /** Waits for the end under way. */
  join(): Promise<unknown>;
}

/** What an end that stops the session's turn first works with: the session, as the sessions core keeps it. */
export interface EndingSession extends InterruptedBeforeEnd {
  /**
   * Ends the session as the core's end does, or joins the end under way,
   * and gives the background tasks known as its process went.
   */
  end(): Promise<readonly BackgroundTask[]>;
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
 * end throws. What {@link interruptBeforeEnd} throws.
 */
export async function endAfterInterrupt(target: EndingSession): Promise<EndResult> {
  const session = target.session();
  if (session === undefined) return { action: 'nothing-to-end' };
  if (session.state === 'ended') return { action: 'nothing-to-end', state: 'ended' };
  await interruptBeforeEnd(target);
  return { action: 'ended', stoppedTasks: await target.end() };
}

/**
 * Does what an end asked by an app does before its signal, by what the
 * session is, as {@link endAfterInterrupt}'s table says: interrupts its
 * turn, whether or not that is confirmed, or joins the end under way, and
 * then interrupts the turn of a session that end left live, its kill
 * failed. Nothing for a session with no turn, none, or one ended.
 *
 * @param target - The session.
 * @throws `CockpitError` `wrong-state` on a `starting` session. What the
 * interrupt throws but its being unconfirmed and the host's failure as
 * the keys are pressed: the close's refusal among them. What the join
 * throws.
 */
export async function interruptBeforeEnd(target: InterruptedBeforeEnd): Promise<void> {
  const session = target.session();
  if (session === undefined || session.state === 'ended') return;
  const interruption = interruptionOf(session);
  if (interruption === 'refused') throw wrongState(session);
  if (target.hasEndUnderWay()) {
    await target.join();
    return interruptBeforeEnd(target);
  }
  if (interruption === 'stop-the-turn') await interruptAnyway(target);
}

/** Interrupts the session's turn; an interrupt that cannot be confirmed does not keep the end from going on. */
async function interruptAnyway(target: InterruptedBeforeEnd): Promise<void> {
  try {
    await target.interrupt();
  } catch (error) {
    if (isCockpitError(error, 'interrupt-unconfirmed') || error instanceof SessionHostError) return;
    throw error;
  }
}
