import type { Ask, AskAnswer, AskSettled } from '../shared/ask.js';
import type { CockpitError } from '../shared/cockpit-error.js';
import type { Choice, JobDescription } from '../shared/job.js';
import type {
  EndResult,
  InterruptResult,
  OpenOptions,
  OpenResult,
  RemoveResult,
  RunOptions,
  RunResult,
  SendResult,
  Session,
} from '../shared/session.js';
import {
  type AnswerRequest,
  ASKS_ANSWER_PATH,
  END_PATH,
  freshOf,
  INTERRUPT_PATH,
  JOBS_PATH,
  type JobsResponse,
  type KeyRequest,
  OPEN_PATH,
  OPTIONS_PATH,
  type OpenRequest,
  type OptionsRequest,
  type OptionsResponse,
  REMOVE_PATH,
  RUN_PATH,
  type RunRequest,
  SEND_PATH,
  type SendRequest,
} from '../shared/wire.js';
import { callEach } from './app-handlers.js';
import { createConnection } from './connection.js';
import { createAsksFollowing } from './follow-asks.js';
import { followSessions } from './follow-sessions.js';
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
   * Runs a job, as the server's `cockpit.run` does. A run the server did
   * not serve because a renewal of the app's token overlapped it is made
   * again once, a second later, with the token the page holds then;
   * nothing of the first was run.
   *
   * @param jobId - The job's id.
   * @param args - The job's arguments, which the server checks against the
   * job's schema.
   * @param options - `fresh`: start a new conversation for the key.
   * @returns What the run did and the state it left the session in.
   * @throws `CockpitError` as the server's `run` throws it (`unknown-job`,
   * `invalid-arguments`, `wrong-state`, …); `refused` or `no-token` from the
   * request checks; `unreachable` when the server cannot be reached, what
   * answers is not the cockpit, or a renewal overlapped the run made again
   * too.
   */
  run(jobId: string, args: unknown, options?: RunOptions): Promise<RunResult>;
  /**
   * Sends a prompt to a unit of work, as the server's `cockpit.send` does;
   * made again once, as a run is, when a renewal of the token overlapped it.
   *
   * @param key - The unit of work's key.
   * @param prompt - The prompt.
   * @returns What the send did and the state it left the session in.
   * @throws `CockpitError` as the server's `send` throws it, and as `run`
   * says for the request checks and `unreachable`.
   */
  send(key: string, prompt: string): Promise<SendResult>;
  /**
   * Opens a unit of work to type in, as the server's `cockpit.open` does;
   * made again once, as a run is, when a renewal of the token overlapped it.
   *
   * @param key - The unit of work's key.
   * @param options - `fresh`: start a new conversation for the key.
   * @returns What the open did and the state it left the session in.
   * @throws `CockpitError` as the server's `open` throws it, and as `run`
   * says for the request checks and `unreachable`.
   */
  open(key: string, options?: OpenOptions): Promise<OpenResult>;
  /**
   * Interrupts a unit of work's turn, as the server's `cockpit.interrupt`
   * does: on a `busy` session, or a `waiting` one whose wait is an ask (one
   * answerable in the terminal only among them) or a channel request, it
   * stops the turn and resolves once the session is `idle`. On an `idle` or
   * `ended` session, a session waiting in the terminal on no ask (a dialog,
   * a panel, a screen the driver cannot read: no key is sent), or a key
   * with no record, it resolves with
   * `nothing-to-interrupt`. Background tasks go on. Made again once, as a run is, when a renewal of the token
   * overlapped it.
   *
   * @param key - The unit of work's key.
   * @returns What the interrupt did; `interrupted` with the `idle` it
   * confirmed (a turn may have begun since: the sessions' list tells the
   * state now).
   * @throws `CockpitError` `wrong-state` (with `key` and `state`) on a
   * `starting` session; `interrupt-unconfirmed` (with `key` and the last
   * `state` known) when the session was not seen `idle` in time; and as
   * `run` says for the request checks and `unreachable`, which also stands
   * for a failure inside the server (its app is told it as
   * `internal-failure`).
   */
  interrupt(key: string): Promise<InterruptResult>;
  /**
   * Ends a unit of work's session, as the server's `cockpit.end` does: on
   * an `idle` session, or one waiting in the terminal on no ask (a dialog,
   * a panel, a screen the driver cannot read), it signals the agent's process at
   * once; on a `busy` session, or a `waiting` one whose wait is an ask or
   * a channel request, it interrupts the turn first. The conversation and
   * the record are kept. On an `ended` session or a key with no record it
   * resolves with `nothing-to-end`. Made again once, as a run is, when a
   * renewal of the token overlapped it.
   *
   * @param key - The unit of work's key.
   * @returns What the end did, with the background tasks stopped with the
   * agent.
   * @throws `CockpitError` `wrong-state` (with `key` and `state`) on a
   * `starting` session; and as `run` says for the request checks and
   * `unreachable`, which also stands for a failure inside the server (its
   * app is told it as `internal-failure`).
   */
  end(key: string): Promise<EndResult>;
  /**
   * Removes a unit of work, as the server's `cockpit.remove` does: it ends
   * a live session first, then deletes everything the cockpit wrote for the
   * key, which is unknown afterwards; the agent's transcripts are left. On
   * a key with neither a record nor a session it resolves with
   * `nothing-to-remove`. Made again
   * once, as a run is, when a renewal of the token overlapped it.
   *
   * @param key - The unit of work's key.
   * @returns What the remove did, with the background tasks stopped with a
   * live session.
   * @throws `CockpitError` `wrong-state` (with `key` and `state`) on a
   * `starting` session; and as `run` says for the request checks and
   * `unreachable`, which also stands for a failure inside the server (its
   * app is told it as `internal-failure`).
   */
  remove(key: string): Promise<RemoveResult>;
  /**
   * Describes the app's jobs, as the server's `cockpit.jobs()` does: each
   * one's schema as JSON Schema, to draw its form from.
   *
   * @returns The jobs, in the order the app gave them.
   * @throws `CockpitError` as `run` says for the request checks and
   * `unreachable`.
   */
  jobs(): Promise<readonly JobDescription[]>;
  /**
   * Reads a field's choices from its option source, as the server's
   * `cockpit.options` does.
   *
   * @param jobId - The job's id.
   * @param field - The field.
   * @param argsSoFar - The arguments filled so far; none when left out.
   * @returns The choices.
   * @throws `CockpitError` as the server's `options` throws it
   * (`unknown-job`, `invalid-arguments`), and as `run` says for the
   * request checks and `unreachable`.
   */
  options(jobId: string, field: string, argsSoFar?: unknown): Promise<readonly Choice[]>;
  /** The sessions. */
  readonly sessions: {
    /**
     * Follows the sessions: the handler receives the list at once, then at
     * every change. After a drop it reconnects by itself, waiting longer
     * after each failed attempt, and the handler receives the list again.
     * A link opened in the page's tab (a new `#cockpit=…`) reconnects it at
     * once, with the link's token.
     *
     * Why a connection could not be made goes to the client's `error`
     * handlers.
     *
     * @param handler - Receives every session the cockpit knows.
     * @returns A function that stops following.
     */
    follow(handler: (sessions: readonly Session[]) => void): () => void;
  };
  /** The agent's asks: followed, answered, and told settled, as the server's `cockpit.asks`. */
  readonly asks: {
    /**
     * Follows the asks of one unit of work, or of every one: the handler
     * receives each pending ask of the scope at once, then each new one,
     * and an ask again when it changes under the same id; never a settled
     * one. After a drop it reconnects as `sessions.follow` does, and the
     * handler receives each ask it was not given yet, or that changed
     * since. Why a connection could not be made goes to the client's
     * `error` handlers.
     *
     * @param key - The unit of work's key, or `'*'` for every one.
     * @param handler - Receives each ask; what it throws goes to the
     * console, and it stays subscribed.
     * @returns A function that stops following.
     * @throws `TypeError` for a key that is neither `'*'` nor a session key.
     */
    follow(key: string, handler: (ask: Ask) => void): () => void;
    /**
     * Answers an ask, as the server's `cockpit.asks.answer` does.
     *
     * @param id - The ask's id.
     * @param answer - The answer, of the ask's kind.
     * @returns A promise fulfilled, with nothing, once the server handed
     * the answer to the agent.
     * @throws `CockpitError` as the server's `asks.answer` throws it
     * (`unknown-id`, `already-settled`, `terminal-only`, `invalid-answer`),
     * and as `run` says for the request checks and `unreachable`.
     */
    answer(id: string, answer: AskAnswer): Promise<void>;
    /**
     * Tells each settlement of an ask the client's follows gave, once,
     * the app's own answers included: from its own message, or, for one
     * made while a follow's socket was down, as it reconnects. An ask whose
     * key was removed meanwhile is forgotten, its settlement never told
     * (the server no longer remembers it): the page learns of the removal
     * from `sessions.follow`. With no follow, none.
     *
     * @param event - `'settled'`.
     * @param handler - Receives the ask's id, its key and what settled it.
     * @returns A function that removes the handler.
     * @throws `TypeError` for an event the asks do not have.
     */
    on(event: 'settled', handler: (settled: AskSettled) => void): () => void;
  };
  /**
   * Tells why one of the client's streams (`sessions.follow`, `asks.follow`) could not
   * connect: the server's refusal (`no-token`, `refused`) or `unreachable`,
   * once per failed attempt. The stream goes on trying, and its handler
   * receives what it follows once connected. A connection that drops and
   * reconnects is not reported, nor a handshake the server asked to be
   * made again (a renewal of the app's token overlapped it). A handler
   * that throws stops neither the other handlers nor the stream; what it
   * threw goes to the console.
   *
   * @param event - `'error'`.
   * @param handler - Receives each error.
   * @returns A function that removes the handler.
   */
  on(event: 'error', handler: (error: CockpitError) => void): () => void;
}

/**
 * Creates the client. It takes the app's token from the page's link (the
 * fragment `#cockpit=…`), removes it from the address bar and keeps it in
 * the origin's local storage, so a reload needs no link; a link opened
 * later in the same tab, which changes only the fragment, is taken the same
 * way, and the client's streams reconnect with it. It sends the token with
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
  const errorHandlers = new Set<(error: CockpitError) => void>();
  const report = (error: CockpitError): void => callEach(errorHandlers, error);
  const asks = createAsksFollowing(connection, report);
  const postKey = (path: string, key: string): Promise<unknown> => {
    const body: KeyRequest = { key };
    return connection.request(path, { method: 'POST', body });
  };
  return {
    run: async (jobId, args, options) => {
      const body: RunRequest = { jobId, args, ...freshOf(options) };
      return (await connection.request(RUN_PATH, { method: 'POST', body })) as RunResult;
    },
    send: async (key, prompt) => {
      const body: SendRequest = { key, prompt };
      return (await connection.request(SEND_PATH, { method: 'POST', body })) as SendResult;
    },
    open: async (key, options) => {
      const body: OpenRequest = { key, ...freshOf(options) };
      return (await connection.request(OPEN_PATH, { method: 'POST', body })) as OpenResult;
    },
    interrupt: async (key) => (await postKey(INTERRUPT_PATH, key)) as InterruptResult,
    end: async (key) => (await postKey(END_PATH, key)) as EndResult,
    remove: async (key) => (await postKey(REMOVE_PATH, key)) as RemoveResult,
    jobs: async () => ((await connection.request(JOBS_PATH)) as JobsResponse).jobs,
    options: async (jobId, field, argsSoFar = {}) => {
      const body: OptionsRequest = { jobId, field, args: argsSoFar };
      const answer = await connection.request(OPTIONS_PATH, { method: 'POST', body });
      return (answer as OptionsResponse).choices;
    },
    sessions: {
      follow: (handler) => followSessions(connection, handler, report),
    },
    asks: {
      follow: asks.follow,
      answer: async (id, answer) => {
        const body: AnswerRequest = { id, answer };
        await connection.request(ASKS_ANSWER_PATH, { method: 'POST', body });
      },
      on: asks.on,
    },
    on: (_event, handler) => {
      // A handler given twice is two subscriptions, each removed by its own function.
      const subscription = (error: CockpitError): void => handler(error);
      errorHandlers.add(subscription);
      return () => {
        errorHandlers.delete(subscription);
      };
    },
  };
}
