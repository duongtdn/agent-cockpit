import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import { CockpitError, isCockpitError } from '../../shared/cockpit-error.js';
import type { RunResult, Session } from '../../shared/session.js';
import {
  type KeyRule,
  RETRY_AFTER_SECONDS,
  type RetryResponse,
  type RunRequest,
  type SessionsMessage,
  type SessionsResponse,
  WIRE_SUBPROTOCOL,
} from '../../shared/wire.js';
import type { CockpitOptions } from '../cockpit-options.js';
import type { FailureSite } from '../failures.js';
import { readBodyWithin } from './body.js';
import { type BridgedSessions, bridgeTerminal } from './pty-bridge.js';
import {
  type AccessRules,
  type Admission,
  admissionOf,
  type Reach,
  terminalRefusalOf,
} from './request-checks.js';
import { headerToken, subprotocolToken } from './request-token.js';
import { requestRouteOf, socketRouteOf } from './router.js';
import {
  answerOfFailure,
  errorAnswer,
  refuseUpgrade,
  type WireAnswer,
  writeAnswer,
} from './wire-errors.js';

/**
 * The largest body of a request taken: a job's arguments are small, and a
 * larger body is refused rather than held in memory.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The largest WebSocket message taken: a terminal's keys come a few at a
 * time, a paste at most a page of text.
 */
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** What the handler serves the browser's requests with. */
export interface HandlerOptions {
  /** The app's token's constant-time comparison: a local request needs the token. */
  readonly tokenMatches: (candidate: string | undefined) => boolean;
  /** Runs a job, as `cockpit.run` does. */
  readonly run: (jobId: string, args: unknown) => Promise<RunResult>;
  /** The sessions, to list and follow. */
  readonly sessions: {
    list(): readonly Session[];
    follow(listener: (sessions: readonly Session[]) => void): () => void;
  };
  /** Where the pty bridge reaches a session. */
  readonly terminals: BridgedSessions;
  /** The driver's terminal keys. */
  readonly keyRules: readonly KeyRule[];
  /** The app's `authorize`, which alone lets a remote request in; none keeps the cockpit on loopback. */
  readonly authorize?: CockpitOptions['authorize'];
  /** The origins allowed beyond `127.0.0.1` and `localhost`. */
  readonly origins: readonly string[];
  /** The terminal's switch. */
  readonly terminal: 'on' | 'loopback' | 'off';
  /**
   * Gives the app a failure the browser is not told of: a 500 of the
   * handler's, an `authorize` that throws.
   */
  readonly reportFailure: (
    where: Extract<FailureSite, 'handler' | 'authorize'>,
    cause: unknown,
  ) => void;
}

/** The cockpit's handler of the browser's requests, as the app mounts it. */
export interface Handler {
  /** Serves an HTTP request under the mount. */
  handle(request: IncomingMessage, response: ServerResponse): void;
  /** Serves a WebSocket upgrade under the mount. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Renews the app's token: puts the new one in force, then closes every
   * browser-facing WebSocket — the sessions' followers and every terminal
   * — so that each reconnect passes the checks again (a live terminal is a
   * shell). A request or handshake whose admission overlaps the renewal
   * was checked, or let in by the app's `authorize`, against a token that
   * may be revoked: it is never admitted, but answered 503 with
   * `Retry-After` and a `RetryResponse`, and comes back as a new request
   * (the client makes it again, its streams reconnect), checked afresh, so
   * that `authorize` is still asked once a request. A refusal stands.
   * Later requests are served as before.
   *
   * @param putInForce - Puts the new token in force; once it settles,
   * `tokenMatches` compares with the new token.
   * @returns A promise fulfilled once every terminal is detached; rejected
   * with what `putInForce` rejected with, no socket closed.
   */
  renewToken(putInForce: () => Promise<void>): Promise<void>;
  /**
   * Refuses every later request, ends every request whose admission is
   * under way (503: an `authorize` that never settles holds nothing open),
   * closes every WebSocket and detaches every terminal.
   *
   * @returns A promise fulfilled once every terminal is detached.
   */
  close(): Promise<void>;
}

/**
 * Creates the handler: every request, HTTP or upgrade, passes the request
 * checks — the app's `authorize` for a remote one, the app's token for a
 * local one — before it is routed, so that nothing of the routes shows to
 * a request that would be refused; the terminal's switch then applies to
 * the terminal's routes.
 *
 * @param options - See {@link HandlerOptions}.
 */
export function createHandler(options: HandlerOptions): Handler {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    // The token's subprotocol is never echoed: the wire's own is chosen.
    handleProtocols: () => WIRE_SUBPROTOCOL,
  });
  const bridges = new Set<Promise<void>>();
  const rules: AccessRules = {
    origins: options.origins,
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    tokenMatches: options.tokenMatches,
    reportAuthorizeFailure: (cause) => options.reportFailure('authorize', cause),
  };
  let closed = false;
  // The renewals of the token under way: an admission that begins while one
  // is may have been checked against the token it revokes.
  let renewalsUnderWay = 0;
  // Each admission under way: the handler's closing ends it, since the
  // app's `authorize` may never settle; a renewal marks it as overlapped.
  const admissionsUnderWay = new Set<AdmissionUnderWay>();

  /**
   * Admits a request, as the request checks do, unless a renewal of the
   * token overlaps its admission (it is to come again, as a new request)
   * or the handler closes first (the admission, whenever it comes, is
   * dropped).
   */
  const admit = (request: IncomingMessage, token: string | undefined): Promise<Verdict> =>
    new Promise((resolve, reject) => {
      const underWay: AdmissionUnderWay = {
        overlapsRenewal: renewalsUnderWay > 0,
        end: () => {
          admissionsUnderWay.delete(underWay);
          resolve({ answer: CLOSING });
        },
      };
      admissionsUnderWay.add(underWay);
      admissionOf(request, token, rules).then(
        (admission) => {
          if (admissionsUnderWay.delete(underWay)) {
            resolve(verdictOf(admission, underWay.overlapsRenewal));
          }
        },
        (error: unknown) => {
          if (admissionsUnderWay.delete(underWay)) reject(error);
        },
      );
    });

  const handle: Handler['handle'] = (request, response) => {
    if (closed) return writeAnswer(response, CLOSING);
    admit(request, headerToken(request))
      .then((verdict) =>
        'answer' in verdict ? verdict.answer : serve(request, verdict.admitted, options),
      )
      .then(
        (answer) => {
          if (answer !== undefined) writeAnswer(response, answer);
        },
        (error: unknown) => {
          if (!isCockpitError(error)) options.reportFailure('handler', error);
          writeAnswer(response, answerOfFailure(error));
        },
      );
  };

  const admitUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    admit(request, subprotocolToken(request)).then(
      (verdict) => {
        if ('answer' in verdict) return refuseUpgrade(socket, verdict.answer);
        upgradeAdmitted(request, socket, head, verdict.admitted);
      },
      (error: unknown) => {
        options.reportFailure('handler', error);
        refuseUpgrade(socket, { status: 500 });
      },
    );
  };

  const upgradeAdmitted = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    reach: Reach,
  ) => {
    const route = socketRouteOf(request.url ?? '');
    if (route === undefined) return refuseUpgrade(socket, { status: 404 });
    const refusal =
      route.route === 'terminal' ? terminalRefusalOf(options.terminal, reach) : undefined;
    if (refusal) return refuseUpgrade(socket, errorAnswer(refusal));
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      if (route.route === 'follow-sessions') {
        followSessions(webSocket, options.sessions);
        return;
      }
      const bridge = bridgeTerminal(webSocket, route.key, options.terminals, options.keyRules);
      bridges.add(bridge);
      void bridge.then(() => bridges.delete(bridge));
    });
  };

  const renewToken: Handler['renewToken'] = async (putInForce) => {
    renewalsUnderWay += 1;
    for (const underWay of admissionsUnderWay) underWay.overlapsRenewal = true;
    try {
      await putInForce();
    } finally {
      renewalsUnderWay -= 1;
    }
    await closeAllSockets();
  };

  const closeAllSockets = async (): Promise<void> => {
    // Terminated, not closed with a handshake: a peer that never answers
    // the close must not keep a shell.
    for (const client of sockets.clients) client.terminate();
    await Promise.all(bridges);
  };

  return {
    handle,
    upgrade(request, socket, head) {
      // Node leaves an upgraded socket without an error listener: one is
      // needed while the admission is under way, or a reset peer would
      // crash the server.
      socket.on('error', () => socket.destroy());
      if (closed) return refuseUpgrade(socket, CLOSING);
      admitUpgrade(request, socket, head);
    },
    renewToken,
    async close() {
      closed = true;
      for (const underWay of [...admissionsUnderWay]) underWay.end();
      await closeAllSockets();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

/** An admission under way: how the handler's closing ends it, and whether a renewal overlapped it. */
interface AdmissionUnderWay {
  readonly end: () => void;
  overlapsRenewal: boolean;
}

/** What becomes of a request once admitted or not: served, from where, or answered at once. */
type Verdict = { readonly admitted: Reach } | { readonly answer: WireAnswer };

/** The answer to a request the handler does not serve because it is closing. */
const CLOSING: WireAnswer = { status: 503 };

/**
 * The answer to a request whose admission overlapped a renewal of the
 * token: no verdict of the checks, which may admit it now, but a request
 * to come again and be checked afresh — the client makes it again, its
 * streams reconnect — told apart from an error by its body.
 */
const RENEWED_MEANWHILE: WireAnswer = {
  status: 503,
  headers: { 'retry-after': String(RETRY_AFTER_SECONDS) },
  body: JSON.stringify({ retry: true } satisfies RetryResponse),
};

function verdictOf(admission: Admission, overlapsRenewal: boolean): Verdict {
  if ('refused' in admission) return { answer: errorAnswer(admission.refused) };
  return overlapsRenewal ? { answer: RENEWED_MEANWHILE } : admission;
}

async function serve(
  request: IncomingMessage,
  reach: Reach,
  options: HandlerOptions,
): Promise<WireAnswer> {
  const route = requestRouteOf(request.method ?? '', request.url ?? '');
  switch (route.route) {
    case 'run':
      return await runJob(request, options);
    case 'sessions': {
      const answer: SessionsResponse = { sessions: options.sessions.list() };
      return json(answer);
    }
    case 'wrong-method':
      return { status: 405, headers: { allow: route.allow } };
    case 'terminal-probe': {
      const refusal = terminalRefusalOf(options.terminal, reach);
      return refusal ? errorAnswer(refusal) : UPGRADE_REQUIRED;
    }
    case 'upgrade-required':
      return UPGRADE_REQUIRED;
    case 'unknown':
      return { status: 404 };
  }
}

async function runJob(request: IncomingMessage, options: HandlerOptions): Promise<WireAnswer> {
  const text = await readBodyWithin(request, MAX_BODY_BYTES);
  if (text === undefined) return { status: 413 };
  const { jobId, args } = runRequestOf(text);
  return json(await options.run(jobId, args));
}

/** Reads the body of a run; what does not fit is refused as the job's arguments. */
function runRequestOf(text: string): RunRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (typeof body !== 'object' || body === null || typeof (body as RunRequest).jobId !== 'string') {
    throw new CockpitError('invalid-arguments', 'The run carries no job id and arguments.', {
      issues: [{ path: ['jobId'], message: 'Expected a JSON body { jobId, args }.' }],
    });
  }
  return body as RunRequest;
}

const UPGRADE_REQUIRED: WireAnswer = { status: 426, headers: { upgrade: 'websocket' } };

function json(value: unknown): WireAnswer {
  return { status: 200, body: JSON.stringify(value) };
}

/** Sends the sessions at once, then at every change, until the socket closes. */
function followSessions(socket: WebSocket, sessions: HandlerOptions['sessions']): void {
  const stop = sessions.follow((list) => {
    const message: SessionsMessage = { type: 'sessions', sessions: list };
    socket.send(JSON.stringify(message));
  });
  socket.once('close', stop);
}
