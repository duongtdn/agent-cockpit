import type { RunResult, Session } from '../shared/session.js';
import { RUN_PATH, type RunRequest } from '../shared/wire.js';
import { createConnection } from './connection.js';
import { type FollowOptions, followSessions } from './follow-sessions.js';
import { takeTokenFromLink } from './token.js';

/** What `createCockpitClient` takes. */
export interface CockpitClientOptions {
  /**
   * Where the app mounted the cockpit's handler: a path (`/cockpit`), resolved
   * against the page's address, or an `http:` or `https:` URL.
   */
  readonly baseUrl: string;
}

/**
 * The browser's side of the cockpit: the server's operations a page needs,
 * by the same names, with the same results and the same errors.
 */
export interface CockpitClient {
  /**
   * Runs a job, as the server's `cockpit.run` does.
   *
   * @param jobId - The job's id.
   * @param args - The job's arguments, which the server checks against the
   * job's schema.
   * @returns What the run did and the state it left the session in.
   * @throws `CockpitError` as the server's `run` throws it (`unknown-job`,
   * `invalid-arguments`, `wrong-state`, …); `refused` or `no-token` from the
   * request checks; `unreachable` when the server cannot be reached.
   */
  run(jobId: string, args: unknown): Promise<RunResult>;
  /** The sessions. */
  readonly sessions: {
    /**
     * Follows the sessions: the handler receives the list at once, then at
     * every change. After a drop it reconnects by itself, waiting longer
     * after each failed attempt, and the handler receives the list again.
     *
     * @param handler - Receives every session the cockpit knows.
     * @param options - `onError`, told why a connection could not be made.
     * @returns A function that stops following.
     */
    follow(handler: (sessions: readonly Session[]) => void, options?: FollowOptions): () => void;
  };
}

/**
 * Creates the client. It takes the app's token from the page's link (the
 * fragment `#cockpit=…`), removes it from the address bar and keeps it in
 * the origin's local storage, so a reload needs no link; it sends it with
 * every request, in a header, and every WebSocket, as a subprotocol, never in
 * a URL. Without a valid token the server refuses every call with
 * `no-token`, on which the app tells the person to open its link.
 *
 * @param options - See {@link CockpitClientOptions}.
 * @returns The client.
 * @throws `CockpitError` `invalid-options` when `baseUrl` is not a path or
 * an HTTP URL.
 */
export function createCockpitClient({ baseUrl }: CockpitClientOptions): CockpitClient {
  const connection = createConnection(baseUrl, takeTokenFromLink());
  return {
    run: async (jobId, args) => {
      const body: RunRequest = { jobId, args };
      return (await connection.request(RUN_PATH, { method: 'POST', body })) as RunResult;
    },
    sessions: {
      follow: (handler, options = {}) => followSessions(connection, handler, options),
    },
  };
}
