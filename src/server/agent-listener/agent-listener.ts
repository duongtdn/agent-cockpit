import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerOptions,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import { HOOKS_PATH, type HookRequest, type JsonValue } from '../driver.js';
import { readBodyWithin } from '../http/body.js';
import type { HookAccess } from '../sessions/sessions.js';
import { readOwnFile, type UntrustedStateError } from '../state/own-files.js';
import { writePrivateFile } from '../state/private-files.js';
import { looksLikeBrowser } from './browser-like.js';
import { createHookTokens, type HookTokens } from './hook-tokens.js';

/** The only address the listener binds: never reachable from the network. */
const LOOPBACK = '127.0.0.1';

/** The state folder's file that remembers the listener's port. */
const PORT_FILE = 'agent-port';

/**
 * The largest hook body taken. A hook carries a tool's input or output,
 * which the agent keeps far below this; a larger body is refused rather
 * than held in memory.
 */
export const MAX_HOOK_BODY_BYTES = 16 * 1024 * 1024;

/**
 * What became of a reply the core gave a held request: handed to the
 * connection, or not written, the agent having closed the connection first.
 */
export type HeldReplyOutcome = 'written' | 'closed';

/** A hook request the core holds: the agent waits on the connection for its reply. */
export interface HeldHook {
  /**
   * Writes the reply as the response's body (`200`, `application/json`)
   * and ends the response. Once `onClosed` was called, after the
   * listener's `close()`, or after a first reply or release, it writes
   * nothing.
   *
   * @param body - The reply.
   * @returns `'written'` once it is handed to the connection; `'closed'`
   * when nothing was written: the agent closed the connection first, the
   * listener's `close()` dropped it, or the request was already replied to
   * or released.
   */
  reply(body: JsonValue): HeldReplyOutcome;
  /**
   * Ends the response with the answer of nothing (`{}`), as a request not
   * held is answered: for a request whose reply the agent no longer reads.
   * Once `onClosed` was called, after the listener's `close()`, or after a
   * first reply or release, it does nothing.
   */
  release(): void;
}

/**
 * Takes a hook request as held: it gets no reply until the core gives one,
 * and no keep-alive bytes meanwhile.
 *
 * @param onClosed - Called once, when the agent closes the connection
 * before a reply ended; never after the listener's `close()`, which drops
 * every held connection.
 * @returns The held request.
 */
export type HookHold = (onClosed: () => void) => HeldHook;

/** What the agent-facing listener is opened with. */
export interface AgentListenerOptions {
  /** The app's state folder, where the port is remembered. */
  readonly folder: string;
  /** The port the app fixes, if it fixes one. */
  readonly agentPort?: number;
  /**
   * Takes a hook whose token was checked: the sessions' `receive`. It holds
   * the request by calling `hold` synchronously, before it returns; a
   * request not held is answered `{}` once it returns.
   */
  readonly receive: (request: HookRequest, hold: HookHold) => void;
  /** Gives the app what failed while a hook was served: the agent is answered 500, and no more. */
  readonly reportFailure: (cause: unknown) => void;
  /**
   * Node's bounds on a connection, its defaults unless given. They bound a
   * request's arrival and a kept-alive connection's idle time only, never a
   * held reply's wait: a test shortens them to show it.
   */
  readonly serverTimeouts?: ServerTimeouts;
}

/** The bounds Node sets on the listener's connections. */
export type ServerTimeouts = Pick<
  ServerOptions,
  'headersTimeout' | 'requestTimeout' | 'keepAliveTimeout' | 'connectionsCheckingInterval'
>;

/** The agent-facing listener, listening. */
export interface AgentListener {
  /** Its port, on `127.0.0.1`. */
  readonly port: number;
  /** Its base URL, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /**
   * The port the last start remembered, when this one listens on another —
   * the port was taken by another program, or the app fixed another: the
   * sessions launched with it can no longer reach the cockpit.
   */
  readonly previousPort?: number;
  /** Hands out and takes back the sessions' tokens. */
  readonly hooks: HookAccess;
  /** Stops listening and ends every open connection. */
  close(): Promise<void>;
}

/**
 * Opens the listener the agent's hooks call: plain HTTP on `127.0.0.1`,
 * apart from the app's server, on a port stable per app, so that live
 * sessions find the cockpit again after a restart. The port is the one the
 * app fixes, else the one remembered in the state folder, else one the
 * system chooses; a remembered port another program has taken is given up
 * for one the system chooses. The port bound is remembered.
 *
 * It serves `POST /hooks`, every request carrying a live session's token as
 * `Authorization: Bearer`. A request that looks like a browser's — an
 * `Origin` header, or a `Host` other than exactly `127.0.0.1:<port>` — is
 * refused 403 before its token is read; one without a live token is refused
 * 401 before anything else is said. A refused request's body is not read.
 *
 * @param options - See {@link AgentListenerOptions}.
 * @returns The listener, listening.
 * @throws The system's `EADDRINUSE` error when the port the app fixes is
 * taken; {@link UntrustedStateError} when the file of the remembered port is
 * a symbolic link, no regular file or another user's; the file system's
 * error when the port cannot be remembered.
 */
export async function openAgentListener(options: AgentListenerOptions): Promise<AgentListener> {
  const portFile = join(options.folder, PORT_FILE);
  const remembered = await readRememberedPort(portFile);
  // Node's request and headers timeouts end once a request has arrived
  // whole, which `serve` waits for before `receive`; its socket timeout is
  // 0 and its keep-alive timeout runs only between requests: none of them
  // cuts a held reply, which may wait on a person for minutes.
  const server = createServer({ ...options.serverTimeouts });
  const port = await bind(server, options.agentPort, remembered);
  const url = `http://${LOOPBACK}:${port}`;
  const tokens = createHookTokens(url);
  const held = new Set<HeldResponse>();
  const closeListener = () => {
    for (const response of held) response.drop();
    return close(server);
  };
  // Requests arrive on later turns of the event loop: none is missed.
  server.on('request', (request, response) => {
    void serve(request, response, { port, tokens, held, ...options });
  });
  if (port !== remembered) {
    await writePrivateFile(portFile, String(port)).catch(async (error: unknown) => {
      await close(server);
      throw error;
    });
  }
  return {
    port,
    url,
    ...(remembered !== undefined && remembered !== port ? { previousPort: remembered } : {}),
    hooks: tokens,
    close: closeListener,
  };
}

async function readRememberedPort(file: string): Promise<number | undefined> {
  const text = await readOwnFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
  return port > 0 && port < 65536 ? port : undefined;
}

async function bind(
  server: Server,
  fixed: number | undefined,
  remembered: number | undefined,
): Promise<number> {
  if (fixed !== undefined) return await listen(server, fixed);
  if (remembered === undefined) return await listen(server, 0);
  try {
    return await listen(server, remembered);
  } catch (error) {
    // Only another program can hold it: the app's lock keeps out its own.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    return await listen(server, 0);
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(port, LOOPBACK, () => {
      server.off('error', failed);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** What the body's read gives when the connection broke before the body ended. */
const CONNECTION_LOST = Symbol('connection lost');

/** What serving one request needs of its listener. */
interface ServeContext extends Pick<AgentListenerOptions, 'receive' | 'reportFailure'> {
  readonly port: number;
  readonly tokens: HookTokens;
  /** The responses held now, which the listener's close drops. */
  readonly held: Set<HeldResponse>;
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  { port, tokens, held, receive, reportFailure }: ServeContext,
): Promise<void> {
  // Before the token: a page learns nothing of the listener's answer to one.
  if (looksLikeBrowser(request.headers, port)) return answer(response, 403);
  const key = tokens.keyOf(bearerToken(request.headers.authorization));
  if (key === undefined) return answer(response, 401);
  const path = new URL(request.url ?? '/', 'http://listener').pathname;
  if (path !== HOOKS_PATH) return answer(response, 404);
  if (request.method !== 'POST') return answer(response, 405, { allow: 'POST' });
  const text = await readBodyWithin(request, MAX_HOOK_BODY_BYTES).catch(
    (): typeof CONNECTION_LOST => CONNECTION_LOST,
  );
  // Node answered the request, cut by its timeout, or the agent left: nothing to say.
  if (text === CONNECTION_LOST) return;
  if (text === undefined) return answer(response, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(response, 400);
  }
  let taken: HeldResponse | undefined;
  try {
    receive({ key, path, body }, (onClosed) => {
      taken = holdResponse(response, held, onClosed);
      return taken;
    });
  } catch (error) {
    taken?.drop();
    reportFailure(error);
    // A reply the sessions gave before failing stands: the agent reads it.
    if (!response.headersSent) answer(response, 500);
    return;
  }
  // A hook's answer of nothing: no decision of the cockpit's.
  if (taken === undefined) writeJson(response, '{}');
}

/** A held hook, as the listener keeps it until it is replied to, released, closed or dropped. */
interface HeldResponse extends HeldHook {
  /** Stops holding it, reporting nothing: the listener ends the connection itself. */
  drop(): void;
}

/**
 * Holds a response until the core replies or releases it, reporting the
 * connection closed if the agent closes it first.
 */
function holdResponse(
  response: ServerResponse,
  held: Set<HeldResponse>,
  onClosed: () => void,
): HeldResponse {
  const drop = () => {
    held.delete(hook);
  };
  const end = (body: string): HeldReplyOutcome => {
    if (!held.has(hook) || connectionGone(response)) return 'closed';
    drop();
    writeJson(response, body);
    return 'written';
  };
  const hook: HeldResponse = {
    reply: (body) => end(JSON.stringify(body)),
    release: () => {
      end('{}');
    },
    drop,
  };
  held.add(hook);
  response.once('close', () => {
    if (!held.has(hook)) return;
    drop();
    onClosed();
  });
  return hook;
}

/**
 * Whether the response can no longer carry the reply: already begun (another
 * hold of the same request replied), or its socket destroyed or no longer
 * writable, though Node has not yet told its close. A response with no
 * socket yet waits behind an earlier one on its connection, and Node writes
 * it once that one ends.
 */
function connectionGone(response: ServerResponse): boolean {
  if (response.headersSent || response.destroyed) return true;
  return response.socket !== null && !response.socket.writable;
}

function writeJson(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(body);
}

function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer (\S+)$/.exec(header ?? '')?.[1];
}

function answer(response: ServerResponse, status: number, headers: Record<string, string> = {}) {
  response.writeHead(status, headers).end();
}
