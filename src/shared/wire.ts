/**
 * The wire between the browser's client and terminal and the cockpit's
 * handler: its paths, how the app's token travels, and the messages each way.
 * It is the cockpit's own detail, never the app's: client and server ship as
 * one version, so both sides read it from here and never drift apart.
 *
 * Every path is relative to where the app mounted the handler, the client's
 * `baseUrl`. An HTTP request carries the token in {@link TOKEN_HEADER}; a
 * WebSocket handshake, which a browser cannot give headers, in a subprotocol
 * ({@link wireSubprotocols}). Neither ever puts it in the URL, where logs and
 * the browser's history would keep it.
 *
 * @packageDocumentation
 */

import type { CockpitErrorCode, CockpitErrorFields } from './cockpit-error.js';
import type { Choice, JobDescription } from './job.js';
import {
  isSessionKey,
  type OpenResult,
  type RunResult,
  type SendResult,
  type Session,
} from './session.js';

/**
 * The header that carries the app's token on an HTTP request. A header of the
 * cockpit's own rather than `Authorization`, which the app's own login, or a
 * proxy in front of it, may use for something else.
 */
export const TOKEN_HEADER = 'cockpit-token';

/**
 * The subprotocol the server selects on every WebSocket of the wire. The
 * browser only completes a handshake whose selected subprotocol is one it
 * offered, so this one is offered beside the token's and selected instead of
 * it: the token is never echoed back.
 */
export const WIRE_SUBPROTOCOL = 'agent-cockpit';

/** What precedes the token in the subprotocol that carries it. */
const TOKEN_CARRIER = `${WIRE_SUBPROTOCOL}.token.`;

/** The characters a subprotocol may hold (RFC 7230's `token`), one or more. */
const SUBPROTOCOL_TEXT = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Tells whether a text can be the app's token on the wire: carried in a
 * subprotocol, so in a header too. A token the server makes always can
 * (base64url without padding, or hex); a text read from a link or a storage
 * may not.
 *
 * @param text - The candidate token.
 * @returns `true` for one or more of the characters a subprotocol may hold.
 */
export function isWireToken(text: string): boolean {
  return SUBPROTOCOL_TEXT.test(text);
}

/**
 * Gives the subprotocols a browser offers when it opens a WebSocket of the
 * wire: {@link WIRE_SUBPROTOCOL}, then one that carries the token.
 *
 * @param token - The app's token.
 * @returns The two subprotocols, in that order.
 * @throws `TypeError` for an empty token, or one holding a character a
 * subprotocol cannot carry (a space, a comma, `=`, `/`, anything beyond
 * ASCII): the browser would refuse to open the socket.
 */
export function wireSubprotocols(token: string): [string, string] {
  if (!isWireToken(token)) {
    throw new TypeError('The token holds characters a WebSocket subprotocol cannot carry.');
  }
  return [WIRE_SUBPROTOCOL, `${TOKEN_CARRIER}${token}`];
}

/**
 * Reads the token from a WebSocket handshake's `Sec-WebSocket-Protocol`
 * header, as {@link wireSubprotocols} made it.
 *
 * @param header - The header's value, as the request has it; `undefined`
 * when there is none.
 * @returns The token; `undefined` when the header does not offer
 * {@link WIRE_SUBPROTOCOL} and exactly one non-empty token, for a handshake
 * whose token cannot be told is one without a token.
 */
export function tokenOfSubprotocols(header: string | undefined): string | undefined {
  const offered = (header ?? '').split(',').map((protocol) => protocol.trim());
  const tokens = offered
    .filter((protocol) => protocol.startsWith(TOKEN_CARRIER))
    .map((protocol) => protocol.slice(TOKEN_CARRIER.length));
  const [token] = tokens;
  return offered.includes(WIRE_SUBPROTOCOL) && tokens.length === 1 && token !== ''
    ? token
    : undefined;
}

/** `POST`: runs a job. The body is a {@link RunRequest}; the answer a {@link RunResponse}. */
export const RUN_PATH = '/run';

/** `POST`: sends a prompt to a unit of work. The body is a {@link SendRequest}; the answer a {@link SendResponse}. */
export const SEND_PATH = '/send';

/** `POST`: opens a unit of work. The body is an {@link OpenRequest}; the answer an {@link OpenResponse}. */
export const OPEN_PATH = '/open';

/** `GET`: describes the jobs. The answer is a {@link JobsResponse}. */
export const JOBS_PATH = '/jobs';

/**
 * `POST`: reads a field's option source. The body is an
 * {@link OptionsRequest}; the answer an {@link OptionsResponse}. A `POST`,
 * since the arguments filled so far are an object of any shape.
 */
export const OPTIONS_PATH = '/options';

/** `GET`: lists the sessions. The answer is a {@link SessionsResponse}. */
export const SESSIONS_PATH = '/sessions';

/**
 * A WebSocket: follows the sessions. The server sends a
 * {@link SessionsMessage} at once, then one at every change; the browser
 * sends nothing.
 */
export const FOLLOW_SESSIONS_PATH = '/follow/sessions';

/** What precedes a session's key in the path of its terminal. */
const TERMINAL_PREFIX = '/terminal/';

/**
 * Gives the path of a session's terminal: a WebSocket, the pty bridge to the
 * session (see {@link TerminalServerMessage} and
 * {@link TerminalClientMessage}).
 *
 * @param key - The session's key.
 * @returns The path, relative to the mount.
 * @throws `TypeError` for a text that is no session key.
 */
export function terminalPath(key: string): string {
  if (!isSessionKey(key)) throw new TypeError(`${JSON.stringify(key)} is no session key.`);
  return `${TERMINAL_PREFIX}${key}`;
}

/**
 * Reads the session's key from the path of a terminal, as
 * {@link terminalPath} made it.
 *
 * @param path - A request's path, without its query.
 * @returns The key; `undefined` when the path is no terminal's.
 */
export function keyOfTerminalPath(path: string): string | undefined {
  if (!path.startsWith(TERMINAL_PREFIX)) return undefined;
  const key = path.slice(TERMINAL_PREFIX.length);
  return isSessionKey(key) ? key : undefined;
}

/** The body of a {@link RUN_PATH} request. */
export interface RunRequest {
  /** The job's id. */
  readonly jobId: string;
  /** The job's arguments, which the server checks against the job's schema. */
  readonly args: unknown;
  /** Whether to start a new conversation for the key; left out, the job decides. */
  readonly fresh?: boolean;
}

/** The answer to a {@link RUN_PATH} request that succeeded: what the run did. */
export type RunResponse = RunResult;

/** The body of a {@link SEND_PATH} request. */
export interface SendRequest {
  /** The key of the unit of work. */
  readonly key: string;
  /** The prompt. */
  readonly prompt: string;
}

/** The answer to a {@link SEND_PATH} request that succeeded: what the send did. */
export type SendResponse = SendResult;

/** The body of an {@link OPEN_PATH} request. */
export interface OpenRequest {
  /** The key of the unit of work. */
  readonly key: string;
  /** Whether to start a new conversation for the key. */
  readonly fresh?: boolean;
}

/** The answer to an {@link OPEN_PATH} request that succeeded: what the open did. */
export type OpenResponse = OpenResult;

/**
 * The `fresh` of a run or an open, as the wire carries it and as the
 * cockpit's operations take it: present only when the caller gave it, so
 * that a run left without it lets the job decide.
 *
 * @param options - A run's or an open's options, or a request's body;
 * `undefined` when there are none.
 * @returns `{ fresh }` when `fresh` is given, `{}` otherwise.
 */
export function freshOf(options: { readonly fresh?: boolean | undefined } | undefined): {
  fresh?: boolean;
} {
  return options?.fresh === undefined ? {} : { fresh: options.fresh };
}

/** The answer to a {@link JOBS_PATH} request. */
export interface JobsResponse {
  /** Every job the app offers, in the order the app gave them. */
  readonly jobs: readonly JobDescription[];
}

/** The body of an {@link OPTIONS_PATH} request. */
export interface OptionsRequest {
  /** The job's id. */
  readonly jobId: string;
  /** The field whose choices are read. */
  readonly field: string;
  /** The arguments filled so far, which the server checks against the job's schema made partial. */
  readonly args: unknown;
}

/** The answer to an {@link OPTIONS_PATH} request. */
export interface OptionsResponse {
  /** The field's choices, as its source gave them. */
  readonly choices: readonly Choice[];
}

/** The answer to a {@link SESSIONS_PATH} request. */
export interface SessionsResponse {
  /** Every session the cockpit knows. */
  readonly sessions: readonly Session[];
}

/**
 * A `CockpitError` as JSON carries it: what its `toJSON` keeps. One type per
 * code, so that the code tells the fields.
 */
export type CockpitErrorJson<C extends CockpitErrorCode = CockpitErrorCode> = {
  [K in C]: {
    /** Always `'CockpitError'`. */
    readonly name: 'CockpitError';
    /** The kind of failure. */
    readonly code: K;
    /** An English sentence for logs and developers. */
    readonly message: string;
  } & Readonly<CockpitErrorFields[K]>;
}[C];

/**
 * The body of every answer that is not a success, refusals of the request
 * checks included, whatever its HTTP status. A refused WebSocket handshake is
 * answered the same way, but a browser cannot read that answer: it learns
 * why from an HTTP request, which the same checks refuse the same way.
 */
export interface ErrorResponse {
  /** The error, for the browser to rebuild as a `CockpitError`. */
  readonly error: CockpitErrorJson;
}

/**
 * The body of the answer to a request or a WebSocket handshake that the
 * server did not serve and asks to be made again: one whose admission
 * overlapped a renewal of the app's token, so was checked against a token
 * that may be revoked. Its status is 503, its `Retry-After`
 * {@link RETRY_AFTER_SECONDS}. It is no error of the cockpit's: the client
 * makes such a request again once, after that wait (nothing of it was
 * served, so a run is not run twice), and a stream counts such a refused
 * handshake as a drop, which reconnects unreported.
 */
export interface RetryResponse {
  /** Always `true`. */
  readonly retry: true;
}

/** How long a request answered with a {@link RetryResponse} waits before it is made again, in seconds. */
export const RETRY_AFTER_SECONDS = 1;

/**
 * Tells whether an answer's JSON is a {@link RetryResponse}.
 *
 * @param body - The answer's body, parsed.
 */
export function isRetryResponse(body: unknown): body is RetryResponse {
  return typeof body === 'object' && body !== null && (body as RetryResponse).retry === true;
}

/** What the server sends on {@link FOLLOW_SESSIONS_PATH}, as a text message. */
export interface SessionsMessage {
  /** Its kind. */
  readonly type: 'sessions';
  /** Every session the cockpit knows, now. */
  readonly sessions: readonly Session[];
}

/** A modifier key held with a key. */
export type KeyModifier = 'shift' | 'ctrl' | 'alt' | 'meta';

/**
 * One of a driver's terminal keys: a key, with exactly the given modifiers
 * held, sends the given text to the session instead of what the terminal
 * would send for it. The terminal applies every driver's rules with one
 * interpreter, so no driver code reaches the browser.
 */
export interface KeyRule {
  /** The key, as the browser's `KeyboardEvent.key` names it (`Enter`). */
  readonly key: string;
  /** The modifiers held, all of them and no other: none is `[]`. */
  readonly modifiers: readonly KeyModifier[];
  /** What is sent in the key's place (for Shift+Enter in Claude Code, `'\x1b\r'`). */
  readonly send: string;
}

/**
 * The first message the server sends on a terminal's WebSocket, as text: the
 * keys of the session's driver.
 */
export interface TerminalKeysMessage {
  /** Its kind. */
  readonly type: 'keys';
  /** The driver's key rules. */
  readonly rules: readonly KeyRule[];
}

/**
 * Sent on a terminal's WebSocket, as text, when the cockpit starts typing a
 * prompt into the session, or when the terminal attaches while it does: the
 * person's keys no longer reach the session; the server keeps them.
 */
export interface TerminalHeldMessage {
  /** Its kind. */
  readonly type: 'held';
}

/**
 * Sent on a terminal's WebSocket, as text, once the prompt's send is over
 * and every key kept meanwhile has reached the session, in order: the
 * person's keys pass again. Also when a start-up dialog takes the place of
 * the input box a long first prompt waits for: the keys kept are then
 * dropped, never typed (`discarded`), and the person's keys pass to answer
 * the dialog.
 */
export interface TerminalReleasedMessage {
  /** Its kind. */
  readonly type: 'released';
  /**
   * Present when keys kept meanwhile were dropped rather than passed on: a
   * start-up dialog took the place of the input box they were typed
   * toward, and they would have answered it unseen.
   */
  readonly discarded?: true;
}

/**
 * What the server sends on a terminal's WebSocket as text. What the session
 * draws comes as binary messages, its UTF-8 bytes, so that output is never
 * mistaken for a message.
 */
export type TerminalServerMessage =
  | TerminalKeysMessage
  | TerminalHeldMessage
  | TerminalReleasedMessage;

/**
 * The terminal's size, in character cells. The browser sends it first, as
 * soon as the socket opens, for the server attaches the session at that
 * size, then again at every change.
 */
export interface TerminalResizeMessage {
  /** Its kind. */
  readonly type: 'resize';
  /** How many cells wide: a whole number, one or more. */
  readonly columns: number;
  /** How many cells high: a whole number, one or more. */
  readonly rows: number;
}

/**
 * What the browser sends on a terminal's WebSocket as text. The person's keys
 * go as binary messages, their UTF-8 bytes.
 */
export type TerminalClientMessage = TerminalResizeMessage;

/**
 * The close code of a terminal's WebSocket when its session has ended, or no
 * session of that key lives: there is nothing to attach to, and reconnecting
 * would find nothing either. Any other close is the connection's, and the
 * terminal reconnects.
 */
export const SESSION_ENDED_CLOSE_CODE = 4000;

/**
 * The close code of a terminal's WebSocket that fell behind: it still held
 * more of the session's output to send than the server keeps for one
 * terminal (4 MiB), its page reading too slowly or not at all. Nothing of
 * the session changed, and its other terminals go on: the terminal
 * reconnects at once, and tmux draws the whole screen anew on the attach.
 * The lines that scrolled past meanwhile are missing from the terminal's
 * scrollback.
 */
export const FELL_BEHIND_CLOSE_CODE = 4001;
