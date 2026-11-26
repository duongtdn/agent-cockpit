import {
  FOLLOW_SESSIONS_PATH,
  keyOfTerminalPath,
  RUN_PATH,
  SESSIONS_PATH,
} from '../../shared/wire.js';

/** Where an HTTP request under the mount goes. */
export type RequestRoute =
  | { readonly route: 'run' }
  | { readonly route: 'sessions' }
  /** A known path asked with another method: `allow` is the one it takes. */
  | { readonly route: 'wrong-method'; readonly allow: string }
  /** A WebSocket's path asked as a plain request. */
  | { readonly route: 'upgrade-required' }
  /**
   * A GET on a terminal's path: its probe. A browser cannot read why a
   * handshake was refused, so the terminal asks the same path over HTTP,
   * which the same checks and the terminal's switch refuse the same way.
   */
  | { readonly route: 'terminal-probe'; readonly key: string }
  | { readonly route: 'unknown' };

/** Where a WebSocket upgrade under the mount goes. */
export type SocketRoute =
  | { readonly route: 'follow-sessions' }
  | { readonly route: 'terminal'; readonly key: string };

/** The HTTP paths, each with the one method it takes. */
const REQUEST_PATHS: Readonly<Record<string, { method: string; route: 'run' | 'sessions' }>> = {
  [RUN_PATH]: { method: 'POST', route: 'run' },
  [SESSIONS_PATH]: { method: 'GET', route: 'sessions' },
};

/**
 * Routes an HTTP request the app gave the handler: every path under the
 * mount is the cockpit's, so one it does not know is `unknown`, never the
 * app's.
 *
 * @param method - The request's method.
 * @param url - The request's URL under the mount, the mount's prefix removed.
 * @returns The route.
 */
export function requestRouteOf(method: string, url: string): RequestRoute {
  const path = pathOf(url);
  const known = Object.hasOwn(REQUEST_PATHS, path) ? REQUEST_PATHS[path] : undefined;
  if (known !== undefined) {
    return method === known.method
      ? { route: known.route }
      : { route: 'wrong-method', allow: known.method };
  }
  const socket = socketRouteOf(path);
  if (socket === undefined) return { route: 'unknown' };
  if (socket.route === 'follow-sessions') return { route: 'upgrade-required' };
  return method === 'GET'
    ? { route: 'terminal-probe', key: socket.key }
    : { route: 'wrong-method', allow: 'GET' };
}

/**
 * Routes a WebSocket upgrade the app gave the handler.
 *
 * @param url - The request's URL under the mount, the mount's prefix removed.
 * @returns The route; `undefined` for a path the cockpit does not know.
 */
export function socketRouteOf(url: string): SocketRoute | undefined {
  const path = pathOf(url);
  if (path === FOLLOW_SESSIONS_PATH) return { route: 'follow-sessions' };
  const key = keyOfTerminalPath(path);
  return key === undefined ? undefined : { route: 'terminal', key };
}

/** The URL's path, without its query; read as it is, never decoded. */
function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}
