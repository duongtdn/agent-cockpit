import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import { CockpitError, isCockpitError } from '../../shared/cockpit-error.js';
import type { RunResult, Session } from '../../shared/session.js';
import {
  type KeyRule,
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
  admissionAfterRenewal,
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
   * Closes every browser-facing WebSocket — the sessions' followers and
   * every terminal — so that each reconnect passes the checks again, as a
   * renewal of the app's token needs (a live terminal is a shell). A
   * handshake whose admission is under way is checked again for the token
   * alone: a verdict of the app's `authorize` stands. Later requests are
   * served as before.
   *
   * @returns A promise fulfilled once every terminal is detached.
   */
  closeAllSockets(): Promise<void>;
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
  // Counts the closings of every socket: a handshake admitted before one is
  // checked again, since the token that admitted it may have been renewed.
  let socketClosings = 0;
  // Ends each request whose admission is under way: the app's `authorize`
  // may never settle, and closing must not wait for it.
  const admissionsUnderWay = new Set<() => void>();

  /**
   * Awaits a request's admission, unless the handler closes first: then
   * `end` answers the request, and the admission, whenever it comes, is
   * dropped.
   *
   * @returns The admission; `undefined` once the handler closed.
   */
  const awaitAdmission = (
    admission: Promise<Admission>,
    end: () => void,
  ): Promise<Admission | undefined> =>
    new Promise((resolve, reject) => {
      const endNow = () => {
        admissionsUnderWay.delete(endNow);
        end();
        resolve(undefined);
      };
      admissionsUnderWay.add(endNow);
      admission.then(
        (given) => {
          if (admissionsUnderWay.delete(endNow)) resolve(given);
        },
        (error: unknown) => {
          if (admissionsUnderWay.delete(endNow)) reject(error);
        },
      );
    });

  const handle: Handler['handle'] = (request, response) => {
    if (closed) return writeAnswer(response, { status: 503 });
    const closing = () => writeAnswer(response, { status: 503 });
    awaitAdmission(admissionOf(request, headerToken(request), rules), closing)
      .then((admission) => {
        if (admission === undefined) return undefined;
        if ('refused' in admission) return errorAnswer(admission.refused);
        return serve(request, admission.admitted, options);
      })
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
    const closingsBefore = socketClosings;
    const token = subprotocolToken(request);
    const closing = () => refuseUpgrade(socket, { status: 503 });
    awaitAdmission(admissionOf(request, token, rules), closing).then(
      (given) => {
        if (given === undefined) return;
        const admission =
          socketClosings === closingsBefore ? given : admissionAfterRenewal(given, token, rules);
        if ('refused' in admission) return refuseUpgrade(socket, errorAnswer(admission.refused));
        upgradeAdmitted(request, socket, head, admission.admitted);
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

  const closeAllSockets = async (): Promise<void> => {
    socketClosings += 1;
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
      if (closed) return refuseUpgrade(socket, { status: 503 });
      admitUpgrade(request, socket, head);
    },
    closeAllSockets,
    async close() {
      closed = true;
      for (const end of [...admissionsUnderWay]) end();
      await closeAllSockets();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
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
