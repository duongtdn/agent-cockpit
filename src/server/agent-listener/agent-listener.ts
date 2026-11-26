import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { HOOKS_PATH, type HookRequest } from '../driver.js';
import { readBodyWithin } from '../http/body.js';
import type { HookAccess } from '../sessions/sessions.js';
import { readOwnFile, type UntrustedStateError } from '../state/own-files.js';
import { writePrivateFile } from '../state/private-files.js';
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

/** What the agent-facing listener is opened with. */
export interface AgentListenerOptions {
  /** The app's state folder, where the port is remembered. */
  readonly folder: string;
  /** The port the app fixes, if it fixes one. */
  readonly agentPort?: number;
  /** Takes a hook whose token was checked: the sessions' `receive`. */
  readonly receive: (request: HookRequest) => void;
  /** Gives the app what failed while a hook was served: the agent is answered 500, and no more. */
  readonly reportFailure: (cause: unknown) => void;
}

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
 * `Authorization: Bearer`; a request without one is refused 401 before
 * anything else is said, and its body is not read.
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
  const server = createServer();
  const port = await bind(server, options.agentPort, remembered);
  const url = `http://${LOOPBACK}:${port}`;
  const tokens = createHookTokens(url);
  // Requests arrive on later turns of the event loop: none is missed.
  server.on('request', (request, response) => {
    void serve(request, response, tokens, options);
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
    close: () => close(server),
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

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  tokens: HookTokens,
  { receive, reportFailure }: Pick<AgentListenerOptions, 'receive' | 'reportFailure'>,
): Promise<void> {
  const key = tokens.keyOf(bearerToken(request.headers.authorization));
  if (key === undefined) return answer(response, 401);
  const path = new URL(request.url ?? '/', 'http://listener').pathname;
  if (path !== HOOKS_PATH) return answer(response, 404);
  if (request.method !== 'POST') return answer(response, 405, { allow: 'POST' });
  const text = await readBodyWithin(request, MAX_HOOK_BODY_BYTES);
  if (text === undefined) return answer(response, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(response, 400);
  }
  try {
    receive({ key, path, body });
  } catch (error) {
    reportFailure(error);
    return answer(response, 500);
  }
  // A hook's answer of nothing: no decision of the cockpit's.
  response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
}

function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer (\S+)$/.exec(header ?? '')?.[1];
}

function answer(response: ServerResponse, status: number, headers: Record<string, string> = {}) {
  response.writeHead(status, headers).end();
}
