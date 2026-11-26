import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import { CockpitError } from '../../shared/cockpit-error.js';
import type { RunResult, Session } from '../../shared/session.js';
import {
  type KeyRule,
  type RunRequest,
  type SessionsMessage,
  type SessionsResponse,
  TOKEN_HEADER,
  tokenOfSubprotocols,
  WIRE_SUBPROTOCOL,
} from '../../shared/wire.js';
import { readBodyWithin } from './body.js';
import { type BridgedSessions, bridgeTerminal } from './pty-bridge.js';
import { refusalOf, tokenRefusalOf } from './request-checks.js';
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
  /** The app's token's constant-time comparison. */
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
}

/** The cockpit's handler of the browser's requests, as the app mounts it. */
export interface Handler {
  /** Serves an HTTP request under the mount. */
  handle(request: IncomingMessage, response: ServerResponse): void;
  /** Serves a WebSocket upgrade under the mount. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Refuses every later request, closes every WebSocket and detaches every
   * terminal.
   *
   * @returns A promise fulfilled once every terminal is detached.
   */
  close(): Promise<void>;
}

/**
 * Creates the handler: every request, HTTP or upgrade, passes the request
 * checks and carries the app's token before it is routed, so that nothing
 * of the routes shows to a request that would be refused.
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
  let closed = false;

  const handle: Handler['handle'] = (request, response) => {
    if (closed) return writeAnswer(response, { status: 503 });
    const refusal =
      refusalOf(request) ?? tokenRefusalOf(headerToken(request), options.tokenMatches);
    if (refusal) return writeAnswer(response, errorAnswer(refusal));
    serve(request, options).then(
      (answer) => writeAnswer(response, answer),
      (error: unknown) => writeAnswer(response, answerOfFailure(error)),
    );
  };

  const upgrade: Handler['upgrade'] = (request, socket, head) => {
    if (closed) return refuseUpgrade(socket, { status: 503 });
    const token = tokenOfSubprotocols(request.headers['sec-websocket-protocol']);
    const refusal = refusalOf(request) ?? tokenRefusalOf(token, options.tokenMatches);
    if (refusal) return refuseUpgrade(socket, errorAnswer(refusal));
    const route = socketRouteOf(request.url ?? '');
    if (route === undefined) return refuseUpgrade(socket, { status: 404 });
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

  return {
    handle,
    upgrade,
    async close() {
      closed = true;
      for (const client of sockets.clients) client.terminate();
      await Promise.all(bridges);
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

async function serve(request: IncomingMessage, options: HandlerOptions): Promise<WireAnswer> {
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
    case 'upgrade-required':
      return { status: 426, headers: { upgrade: 'websocket' } };
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

function json(value: unknown): WireAnswer {
  return { status: 200, body: JSON.stringify(value) };
}

function headerToken(request: IncomingMessage): string | undefined {
  const value = request.headers[TOKEN_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/** Sends the sessions at once, then at every change, until the socket closes. */
function followSessions(socket: WebSocket, sessions: HandlerOptions['sessions']): void {
  const stop = sessions.follow((list) => {
    const message: SessionsMessage = { type: 'sessions', sessions: list };
    socket.send(JSON.stringify(message));
  });
  socket.once('close', stop);
}
