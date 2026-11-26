import type { ServerResponse } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type CockpitError,
  type CockpitErrorCode,
  isCockpitError,
} from '../../shared/cockpit-error.js';
import type { ErrorResponse } from '../../shared/wire.js';

/**
 * The HTTP status that carries each code on the wire. The client reads the
 * error from the body alone (ADR-0058), so the status is for what stands
 * between — logs, proxies, a developer's network panel — and says the
 * kind of failure in HTTP's terms:
 *
 * - 400: the request does not fit (its arguments, its answer, its prompt);
 * - 401: it carries no proof that it is the person's browser;
 * - 403: the request checks refuse it whatever it carries;
 * - 404: it names nothing the cockpit has (a job, a key, an id);
 * - 409: the state of the unit of work refuses it;
 * - 502: the agent, or the model's API, failed to do it (the one-shot
 *   call's failures included);
 * - 503: the machine cannot run it now (no agent, the cap reached, no
 *   port of the app's known);
 * - 504: the agent did not confirm it in time;
 * - 500: a code no request can raise (creating the cockpit, the
 *   client's own), should one ever reach the wire.
 *
 * A record over every code, so that a new code cannot be left out.
 */
export const STATUS_OF_CODE: Readonly<Record<CockpitErrorCode, number>> = {
  'invalid-options': 500,
  'unsupported-machine': 500,
  'cockpit-locked': 500,
  'unknown-job': 404,
  'invalid-arguments': 400,
  'not-a-choice': 400,
  'folder-outside-app': 400,
  'folder-changed': 409,
  'unknown-key': 404,
  'wrong-state': 409,
  'prompt-not-taken': 409,
  'prompt-too-long': 400,
  'interrupt-unconfirmed': 504,
  'agent-not-found': 503,
  'agent-too-old': 503,
  unobservable: 502,
  'session-cap-reached': 503,
  'no-app-port': 503,
  'unknown-id': 404,
  'already-settled': 409,
  'terminal-only': 409,
  'invalid-answer': 400,
  'not-logged-in': 502,
  'model-unavailable': 502,
  'invalid-output': 502,
  'api-error': 502,
  refused: 403,
  'no-token': 401,
  unreachable: 500,
  'internal-failure': 500,
};

/** An answer of the handler's, before it is written: a status and a body. */
export interface WireAnswer {
  readonly status: number;
  /** JSON; absent for an answer with no body. */
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Gives the answer that carries a failure: a `CockpitError` with its
 * status and its JSON (an {@link ErrorResponse}); anything else — a bug, or
 * a failure no code names, such as a session an earlier run left on the
 * host — as 500 with no body, so that nothing of the server's inside
 * reaches the browser.
 *
 * @param error - What the operation threw.
 */
export function answerOfFailure(error: unknown): WireAnswer {
  if (!isCockpitError(error)) return { status: 500 };
  return errorAnswer(error);
}

/** The answer that carries a `CockpitError`. */
export function errorAnswer(error: CockpitError): WireAnswer {
  const body: ErrorResponse = { error: error.toJSON() as unknown as ErrorResponse['error'] };
  return { status: STATUS_OF_CODE[error.code], body: JSON.stringify(body) };
}

/**
 * Writes an answer to an HTTP request. Nothing the cockpit answers may be
 * kept by a cache: its answers are the state of sessions, now.
 */
export function writeAnswer(response: ServerResponse, answer: WireAnswer): void {
  response.writeHead(answer.status, headersOf(answer)).end(answer.body);
}

/**
 * Writes an answer on the socket of a WebSocket handshake that is refused,
 * then ends it: the HTTP answer a browser cannot read, but every other
 * client can, and the socket destroyed.
 */
export function refuseUpgrade(socket: Duplex, answer: WireAnswer): void {
  const lines = [
    `HTTP/1.1 ${answer.status} ${STATUS_CODES[answer.status] ?? ''}`,
    ...Object.entries({
      ...headersOf(answer),
      connection: 'close',
      'content-length': String(Buffer.byteLength(answer.body ?? '')),
    }).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.end(`${lines.join('\r\n')}\r\n\r\n${answer.body ?? ''}`, () => socket.destroy());
}

function headersOf(answer: WireAnswer): Record<string, string> {
  return {
    'cache-control': 'no-store',
    ...(answer.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...answer.headers,
  };
}
