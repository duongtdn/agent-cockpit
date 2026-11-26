import type { CockpitError } from '../shared/cockpit-error.js';
import type { Session } from '../shared/session.js';
import { FOLLOW_SESSIONS_PATH } from '../shared/wire.js';
import type { Connection } from './connection.js';
import { reconnectDelay } from './reconnect-delay.js';

/**
 * Follows the sessions over the wire's WebSocket: delivers the list the
 * server sends at once, then at every change, and reconnects after a drop,
 * a refusal or an unreachable server, waiting longer after each failure. A
 * link that gives the page a new token reconnects it at once, with it.
 *
 * @param report - Told why a connection could not be made, once per failed
 * attempt, after the next attempt is set; a drop that only needs a
 * reconnection is not reported, nor a handshake the server asked to be
 * made again (a renewal of the app's token overlapped it).
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

  const explainThenReconnect = async (failed: WebSocket): Promise<void> => {
    const error = await connection.explainFailedSocket(FOLLOW_SESSIONS_PATH);
    // Stopped, or replaced by a socket with a new token: this failure is no longer the page's.
    if (stopped || socket !== failed) return;
    reconnectLater();
    // A handshake the server asked to be made again failed nothing: a drop.
    if (error !== undefined) report(error);
  };

  function connect(): void {
    const current = connection.openSocket(FOLLOW_SESSIONS_PATH);
    socket = current;
    const isCurrent = (): boolean => !stopped && socket === current;
    let opened = false;
    current.addEventListener('open', () => {
      opened = true;
    });
    current.addEventListener('message', ({ data }: MessageEvent) => {
      const sessions = isCurrent() ? sessionsOf(data) : undefined;
      if (sessions === undefined) return;
      failures = 0;
      handler(sessions);
    });
    current.addEventListener('close', () => {
      if (!isCurrent()) return;
      if (opened) reconnectLater();
      else void explainThenReconnect(current);
    });
  }

  const reconnectWithNewToken = (): void => {
    clearTimeout(retry);
    failures = 0;
    const replaced = socket;
    connect();
    replaced?.close();
  };

  const stopWatchingLinks = connection.onLinkedToken(reconnectWithNewToken);
  connect();
  return () => {
    stopped = true;
    stopWatchingLinks();
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
