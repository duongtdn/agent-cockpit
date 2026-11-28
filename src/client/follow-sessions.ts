import type { CockpitError } from '../shared/cockpit-error.js';
import type { Session } from '../shared/session.js';
import { FOLLOW_SESSIONS_PATH } from '../shared/wire.js';
import type { Connection } from './connection.js';
import { followStream, typedMessageOf } from './follow-stream.js';

/**
 * Follows the sessions over the wire's WebSocket: delivers the list the
 * server sends at once, then at every change, and reconnects as
 * {@link followStream} says.
 *
 * @param report - Told why a connection could not be made, as
 * {@link followStream} tells it.
 * @returns A function that stops following and closes the socket.
 */
export function followSessions(
  connection: Connection,
  handler: (sessions: readonly Session[]) => void,
  report: (error: CockpitError) => void,
): () => void {
  return followStream(
    connection,
    FOLLOW_SESSIONS_PATH,
    { read: sessionsOf, deliver: handler },
    report,
  );
}

/**
 * The list a `SessionsMessage` carries; `undefined` for anything else, which
 * is skipped rather than shown as a list.
 */
function sessionsOf(data: unknown): readonly Session[] | undefined {
  const message = typedMessageOf(data);
  return message?.type === 'sessions' && Array.isArray(message.sessions)
    ? (message.sessions as readonly Session[])
    : undefined;
}
