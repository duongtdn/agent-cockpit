import { CockpitError } from '../shared/cockpit-error.js';
import { SESSIONS_PATH, TOKEN_HEADER, WIRE_SUBPROTOCOL, wireSubprotocols } from '../shared/wire.js';
import type { TokenKeeper } from './token.js';
import { errorOfAnswer, unreachable } from './wire-error.js';

/**
 * How the page reaches the cockpit's handler: where it is mounted, and the
 * app's token sent with every request. The client and the mounted terminal
 * both reach the server through one.
 */
export interface Connection {
  /**
   * Sends an HTTP request to a path of the wire, the token in its header.
   *
   * @param path - The wire's path, relative to the mount.
   * @param init - The request's method and body; JSON when a body is given.
   * @returns The answer's JSON.
   * @throws `CockpitError` rebuilt from the server's error; `unreachable`
   * when the server cannot be reached or what answers is not the cockpit.
   */
  request(path: string, init?: { method: string; body: unknown }): Promise<unknown>;
  /**
   * Opens a WebSocket on a path of the wire, the token in its subprotocols.
   *
   * @param path - The wire's path, relative to the mount.
   * @returns The socket, connecting.
   */
  openSocket(path: string): WebSocket;
  /**
   * Says why a WebSocket of the wire was not opened. A browser cannot read
   * the answer to a refused handshake, so this asks the same checks over
   * HTTP, which refuse the same way.
   *
   * @returns The server's refusal; `unreachable` when there is none to read.
   */
  explainFailedSocket(): Promise<CockpitError>;
}

/**
 * Creates the {@link Connection} to the handler mounted at `baseUrl`.
 *
 * @param baseUrl - Where the app mounted the handler: a path or an `http:` or
 * `https:` URL, resolved against the page's address.
 * @param token - The keeper of the app's token.
 * @throws `CockpitError` `invalid-options` when `baseUrl` is no such URL.
 */
export function createConnection(baseUrl: unknown, token: TokenKeeper): Connection {
  const mount = resolveMount(baseUrl);
  const urlOf = (path: string): URL => new URL(`${mount}${path}`);

  const request: Connection['request'] = async (path, init) => {
    const current = token.current();
    const headers: Record<string, string> =
      current === undefined ? {} : { [TOKEN_HEADER]: current };
    if (init !== undefined) headers['content-type'] = 'application/json';
    let answer: Response;
    try {
      answer = await fetch(urlOf(path), {
        method: init?.method ?? 'GET',
        headers,
        cache: 'no-store',
        ...(init === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (cause) {
      throw unreachable(`The cockpit at ${mount} cannot be reached.`, cause);
    }
    if (!answer.ok) throw await errorOfAnswer(answer);
    try {
      return await answer.json();
    } catch (cause) {
      throw unreachable(`The cockpit at ${mount} answered ${path} with no JSON.`, cause);
    }
  };

  return {
    request,
    openSocket: (path) => {
      const url = urlOf(path);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = token.current();
      return new WebSocket(
        url,
        current === undefined ? [WIRE_SUBPROTOCOL] : wireSubprotocols(current),
      );
    },
    explainFailedSocket: async () => {
      try {
        await request(SESSIONS_PATH);
      } catch (error) {
        return error as CockpitError;
      }
      return unreachable(
        `The cockpit at ${mount} answers HTTP but did not open a WebSocket: a proxy between may not pass them.`,
      );
    },
  };
}

/**
 * The mount's absolute URL, without query, fragment or the slash that may
 * end it, so that the wire's paths append to it.
 */
function resolveMount(baseUrl: unknown): string {
  const mount = typeof baseUrl === 'string' ? parseUrl(baseUrl) : undefined;
  if (mount === undefined || (mount.protocol !== 'http:' && mount.protocol !== 'https:')) {
    throw new CockpitError(
      'invalid-options',
      'The client needs a baseUrl: a path or an HTTP URL.',
      {
        issues: [{ path: ['baseUrl'], message: 'Expected a path or an http: or https: URL.' }],
      },
    );
  }
  return `${mount.origin}${mount.pathname.replace(/\/+$/, '')}`;
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text, location.href);
  } catch {
    return undefined;
  }
}
