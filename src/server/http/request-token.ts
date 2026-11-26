import type { IncomingHttpHeaders } from 'node:http';
import { TOKEN_HEADER, tokenOfSubprotocols } from '../../shared/wire.js';

/**
 * A request as far as its token goes: its headers. Node's `IncomingMessage`
 * fits, and so does a framework's request that keeps Node's headers
 * (Fastify's).
 */
export interface RequestHeaders {
  /** The request's headers, their names in lower case, as Node gives them. */
  readonly headers: IncomingHttpHeaders;
}

/**
 * The token an HTTP request carries, in its `cockpit-token` header.
 *
 * @returns The token; `undefined` when there is none.
 */
export function headerToken({ headers }: RequestHeaders): string | undefined {
  const value = headers[TOKEN_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The token a WebSocket handshake carries, in its subprotocol: a browser
 * cannot give a handshake headers of its own.
 *
 * @returns The token; `undefined` when there is none.
 */
export function subprotocolToken({ headers }: RequestHeaders): string | undefined {
  return tokenOfSubprotocols(headers['sec-websocket-protocol']);
}

/**
 * Tells whether a request carries the app's token where the handler reads
 * it: a WebSocket handshake in its subprotocol, any other request in its
 * header. No address is checked: that is the request checks' part.
 *
 * @param request - The request.
 * @param matches - The app's token's constant-time comparison.
 * @returns `true` when the token is the app's.
 */
export function carriesAppToken(
  request: RequestHeaders,
  matches: (candidate: string | undefined) => boolean,
): boolean {
  const isHandshake = request.headers.upgrade?.toLowerCase() === 'websocket';
  return matches(isHandshake ? subprotocolToken(request) : headerToken(request));
}
