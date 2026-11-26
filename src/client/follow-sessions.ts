import type { CockpitError } from '../shared/cockpit-error.js';
import type { Session } from '../shared/session.js';
import { FOLLOW_SESSIONS_PATH } from '../shared/wire.js';
import type { Connection } from './connection.js';
import { reconnectDelay } from './reconnect-delay.js';

/**
 * Follows the sessions over the wire's WebSocket: delivers the list the
 * server sends at once, then at every change, and reconnects after a drop,
 * a refusal or an unreachable server, waiting longer after each failure.
 *
 * @param report - Told why a connection could not be made, once per failed
 * attempt; a drop that only needs a reconnection is not reported.
 * @returns A function that stops following and closes the socket.
 */
export function followSessions(
  connection: Connection,
  handler: (sessions: readonly Session[]) => void,
  report: (error: CockpitError) => void,
): () => void {
  let stopped = false;
  let failures = 0;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const reconnectLater = (): void => {
    retry = setTimeout(connect, reconnectDelay(failures));
    failures += 1;
  };

  const explainThenReconnect = async (): Promise<void> => {
    const error = await connection.explainFailedSocket();
    if (stopped) return;
    report(error);
    reconnectLater();
  };

  function connect(): void {
    const current = connection.openSocket(FOLLOW_SESSIONS_PATH);
    socket = current;
    let opened = false;
    current.addEventListener('open', () => {
      opened = true;
    });
    current.addEventListener('message', ({ data }: MessageEvent) => {
      const sessions = sessionsOf(data);
      if (sessions === undefined) return;
      failures = 0;
      handler(sessions);
    });
    current.addEventListener('close', () => {
      if (stopped) return;
      if (opened) reconnectLater();
      else void explainThenReconnect();
    });
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  };
}

/**
 * The list a `SessionsMessage` carries; `undefined` for anything else, which
 * is skipped rather than shown as a list.
 */
function sessionsOf(data: unknown): readonly Session[] | undefined {
  if (typeof data !== 'string') return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, sessions } = message as { type?: unknown; sessions?: unknown };
  return type === 'sessions' && Array.isArray(sessions) ? sessions : undefined;
}
