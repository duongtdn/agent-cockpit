import type { Session } from '../../shared/session.js';
import type { DriverEvent } from '../driver.js';

/**
 * Gives the session a driver's event leaves: the same object when the event
 * changes nothing, so that the caller tells a change by identity. A session
 * that stays in its state keeps its `since`: it entered the state once.
 *
 * `ending` changes no state: the agent only says why it will end, and the
 * session has ended only once its process is gone.
 *
 * @param session - The session as it is; never `ended`, whose events the
 * caller drops.
 * @param event - What a hook told.
 * @param launchedWithPrompt - Whether the launch gave the agent a first
 * prompt: then `ready` is not `idle`, for the agent goes on to take it.
 * @param now - The time of the event, as `since` holds it.
 */
export function sessionAfter(
  session: Session,
  event: DriverEvent,
  launchedWithPrompt: boolean,
  now: string,
): Session {
  const { key, state } = session;
  switch (event.type) {
    case 'ready':
      return state === 'starting' && !launchedWithPrompt
        ? { key, state: 'idle', since: now }
        : session;
    case 'prompt-taken':
    case 'working':
      return state === 'busy' ? session : { key, state: 'busy', since: now };
    case 'turn-ended':
      if (state === 'idle') return session;
      return event.lastMessage === undefined
        ? { key, state: 'idle', since: now }
        : { key, state: 'idle', since: now, lastMessage: event.lastMessage };
    case 'ending':
      return session;
  }
}
