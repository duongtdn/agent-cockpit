import type { IncomingMessage } from 'node:http';
import { CockpitError, type CockpitErrorFields } from '../../shared/cockpit-error.js';

/** Why the request checks refuse a request. */
export type RefusalCause = CockpitErrorFields['refused']['cause'];

/**
 * The headers a proxy or tunnel adds to a request it forwards: a request
 * that carries one is remote, whatever address it comes from (ADR-0040).
 */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip'] as const;

/** The loopback addresses a local request reaches: another `127.x` is refused. */
const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** The host names a local request's `Host` and `Origin` may name, any port. */
const LOCAL_HOST_NAMES: readonly string[] = ['127.0.0.1', 'localhost'];

/** A loopback peer: any of `127.0.0.0/8`, IPv4-mapped or not, or `::1`. */
const LOOPBACK_PEER = /^(::ffff:)?127(\.\d{1,3}){3}$|^::1$/;

/** A `Host` header: a name, then a port or none. */
const HOST_HEADER = /^([^:]+)(:\d{1,5})?$/;

/**
 * Checks a browser-facing request, HTTP or WebSocket handshake alike,
 * against the cockpit's loopback-only default (ADR-0016, ADR-0038,
 * ADR-0040). In order: it comes from a loopback address (`remote`), carries
 * no forwarding header (`forwarded`), reaches `127.0.0.1` or `::1` itself
 * (`local-address`), names `127.0.0.1` or `localhost` in its `Host`
 * (`host`, which stops DNS rebinding) and, when it has one, in its `Origin`
 * (`origin`), any port.
 *
 * @param request - The request, as the app's server received it.
 * @returns The `refused` error naming the first check that fails;
 * `undefined` when the request is local.
 */
export function refusalOf(request: IncomingMessage): CockpitError<'refused'> | undefined {
  const cause = causeOfRefusal(request);
  return cause === undefined ? undefined : refused(cause);
}

function causeOfRefusal({ socket, headers }: IncomingMessage): RefusalCause | undefined {
  if (!LOOPBACK_PEER.test(socket.remoteAddress ?? '')) return 'remote';
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return 'forwarded';
  if (!LOOPBACK_ADDRESSES.includes(socket.localAddress ?? '')) return 'local-address';
  if (!isLocalHost(headers.host)) return 'host';
  if (headers.origin !== undefined && !isLocalOrigin(headers.origin)) return 'origin';
  return undefined;
}

function isLocalHost(host: string | undefined): boolean {
  const name = HOST_HEADER.exec(host ?? '')?.[1];
  return name !== undefined && LOCAL_HOST_NAMES.includes(name.toLowerCase());
}

function isLocalOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    LOCAL_HOST_NAMES.includes(url.hostname)
  );
}

const MESSAGES: Record<RefusalCause, string> = {
  remote: 'The request comes from beyond the loopback, and the cockpit is not opened to it.',
  forwarded:
    'The request carries a forwarding header: a proxy or tunnel forwarded it, and the cockpit is not opened to remote requests.',
  'local-address': 'The request reaches a local address other than 127.0.0.1 or ::1.',
  host: 'The request names a host other than 127.0.0.1 or localhost.',
  origin: 'The request comes from a page whose origin is not on 127.0.0.1 or localhost.',
  'terminal-off': 'The terminal is turned off.',
};

function refused(cause: RefusalCause): CockpitError<'refused'> {
  return new CockpitError('refused', MESSAGES[cause], { cause });
}

/**
 * Tells whether a request carries the app's token, after the request checks
 * passed: an HTTP request in its `cockpit-token` header, a WebSocket
 * handshake in its subprotocol.
 *
 * @param candidate - The token the request carried; `undefined` for none.
 * @param matches - The app's token's constant-time comparison.
 * @returns The `no-token` error; `undefined` when the token is the app's.
 */
export function tokenRefusalOf(
  candidate: string | undefined,
  matches: (candidate: string | undefined) => boolean,
): CockpitError<'no-token'> | undefined {
  if (matches(candidate)) return undefined;
  return new CockpitError(
    'no-token',
    "The request carries no valid token: the person opens the app's link.",
  );
}
