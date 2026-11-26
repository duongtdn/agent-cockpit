import { CockpitError } from '../shared/cockpit-error.js';
import {
  RETRY_AFTER_SECONDS,
  type RetryResponse,
  TOKEN_HEADER,
  WIRE_SUBPROTOCOL,
  wireSubprotocols,
} from '../shared/wire.js';
import type { TokenKeeper } from './token.js';
import { failureOfAnswer, unreachable } from './wire-error.js';

/** What the cockpit answers a plain GET on a WebSocket's path whose checks pass. */
const UPGRADE_REQUIRED = 426;

/**
 * How the page reaches the cockpit's handler: where it is mounted, and the
 * app's token sent with every request. The client and the mounted terminal
 * both reach the server through one.
 */
export interface Connection {
  /**
   * Sends an HTTP request to a path of the wire, the token in its header.
   * A request the server asks to be made again (a renewal of the app's
   * token overlapped it, and nothing of it was served) is made again once,
   * after the wire's wait, with the token the page holds then.
   *
   * @param path - The wire's path, relative to the mount.
   * @param init - The request's method and body; JSON when a body is given.
   * @returns The answer's JSON.
   * @throws `CockpitError` rebuilt from the server's error; `unreachable`
   * when the server cannot be reached, what answers is not the cockpit, or
   * the server asks again for the request made again.
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
   * the answer to a refused handshake, so this asks the socket's own path
   * over HTTP, which the same checks refuse the same way, and which answers
   * 426 when they pass.
   *
   * @param path - The socket's path, relative to the mount.
   * @returns The server's refusal; `unreachable` when there is none to
   * read: no answer, an answer not the cockpit's or broken off, or the
   * checks passing though no WebSocket opened; `undefined` when the server
   * asks for the handshake to be made again (a renewal of the app's token
   * overlapped it): no failure, a drop to reconnect after. It never
   * rejects.
   */
  explainFailedSocket(path: string): Promise<CockpitError | undefined>;
  /**
   * Tells when a link opened in the page's tab gives it a new token, so that
   * a stream connects again at once with it, rather than after its wait.
   *
   * @param listener - Called once per such link.
   * @returns A function that stops telling it.
   */
  onLinkedToken(listener: () => void): () => void;
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

  /** Sends a request, the token in its header; `unreachable` when nothing answers. */
  const send = async (
    path: string,
    init?: { method: string; body: unknown },
  ): Promise<Response> => {
    const current = token.current();
    const headers: Record<string, string> =
      current === undefined ? {} : { [TOKEN_HEADER]: current };
    if (init !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(urlOf(path), {
        method: init?.method ?? 'GET',
        headers,
        cache: 'no-store',
        ...(init === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (cause) {
      throw unreachable(`The cockpit at ${mount} cannot be reached.`, cause);
    }
  };

  /** Sends a request once: the answer's JSON, or the server's asking for it again. */
  const attempt = async (
    path: string,
    init?: { method: string; body: unknown },
  ): Promise<{ readonly json: unknown } | RetryResponse> => {
    const answer = await send(path, init);
    if (!answer.ok) {
      const failure = await failureOfAnswer(answer);
      if ('error' in failure) throw failure.error;
      return failure;
    }
    try {
      return { json: await answer.json() };
    } catch (cause) {
      throw unreachable(`The cockpit at ${mount} answered ${path} with no JSON.`, cause);
    }
  };

  const request: Connection['request'] = async (path, init) => {
    const first = await attempt(path, init);
    if ('json' in first) return first.json;
    // Nothing of the first was served: a run made again is not run twice.
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_SECONDS * 1000));
    const second = await attempt(path, init);
    if ('json' in second) return second.json;
    throw unreachable(
      `The cockpit at ${mount} served ${path} neither time it was made: a renewal of its token overlapped both.`,
    );
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
    explainFailedSocket: async (path) => {
      let answer: Response;
      try {
        answer = await send(path);
      } catch (error) {
        return error as CockpitError;
      }
      if (answer.status !== UPGRADE_REQUIRED) {
        const failure = await failureOfAnswer(answer);
        return 'error' in failure ? failure.error : undefined;
      }
      return unreachable(
        `The cockpit at ${mount} lets ${path} through but did not open its WebSocket: a proxy between may not pass them.`,
      );
    },
    onLinkedToken: (listener) => token.onLinked(listener),
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
