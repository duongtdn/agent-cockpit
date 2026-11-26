import type { IncomingMessage } from 'node:http';
import { CockpitError, type CockpitErrorFields } from '../../shared/cockpit-error.js';

/** Why the request checks refuse a request. */
export type RefusalCause = CockpitErrorFields['refused']['cause'];

/** Why a request is remote: its peer is beyond the loopback, or a proxy forwarded it. */
type RemoteCause = Extract<RefusalCause, 'remote' | 'forwarded'>;

/** Where an admitted request comes from: the machine itself, or beyond it. */
export type Reach = 'local' | 'remote';

/** Who may reach the browser-facing surfaces: the app's opening of them, and its token. */
export interface AccessRules {
  /** The origins allowed beyond `127.0.0.1` and `localhost`, as browsers send them. */
  readonly origins: readonly string[];
  /** The app's `authorize`, which alone admits a remote request; none keeps the cockpit on loopback. */
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** The app's token's constant-time comparison. */
  readonly tokenMatches: (candidate: string | undefined) => boolean;
  /** Gives the app what its `authorize` threw or rejected with. */
  readonly reportAuthorizeFailure: (cause: unknown) => void;
}

/** What the checks made of a request: admitted, from where, or refused, with why. */
export type Admission =
  | { readonly admitted: Reach }
  | { readonly refused: CockpitError<'refused'> | CockpitError<'no-token'> };

/**
 * The headers a proxy or tunnel adds to a request it forwards: a request
 * that carries one is remote, whatever address it comes from (ADR-0040).
 */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip'] as const;

/** The loopback addresses a local request reaches: another `127.x` is refused. */
const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** The host names a request's `Host` and `Origin` may always name, any port. */
const LOCAL_HOST_NAMES: readonly string[] = ['127.0.0.1', 'localhost'];

/** A loopback peer: any of `127.0.0.0/8`, IPv4-mapped or not, or `::1`. */
const LOOPBACK_PEER = /^(::ffff:)?127(\.\d{1,3}){3}$|^::1$/;

/** A `Host` header naming a host without brackets: a name, then a port or none. */
const HOST_HEADER = /^([^:]+)(:\d{1,5})?$/;

/**
 * Checks a browser-facing request, HTTP or WebSocket handshake alike
 * (ADR-0016, ADR-0037, ADR-0038, ADR-0040). In order:
 *
 * 1. A remote request — from beyond the loopback (`remote`) or carrying a
 *    forwarding header (`forwarded`) — is refused when the app gave no
 *    `authorize`: the cockpit is not opened.
 * 2. A loopback peer must reach `127.0.0.1` or `::1` itself
 *    (`local-address`).
 * 3. Its `Host` must name `127.0.0.1` or `localhost`, any port, or the host
 *    and port of an allowed origin (`host`, which stops DNS rebinding); its
 *    `Origin`, when it has one, must be on those names or be an allowed
 *    origin exactly (`origin`).
 * 4. A remote request is then admitted only when `authorize` resolves
 *    `true` — it needs no token; otherwise it is refused with its own
 *    cause, and an `authorize` that throws or rejects is reported to the
 *    app. A local request needs the app's token (`no-token`); it never
 *    reaches `authorize`.
 *
 * @param request - The request, as the app's server received it.
 * @param token - The token it carried: the header's on HTTP, the
 * subprotocol's on a handshake; `undefined` for none.
 * @param rules - See {@link AccessRules}.
 * @returns The admission; it never rejects.
 */
export async function admissionOf(
  request: IncomingMessage,
  token: string | undefined,
  rules: AccessRules,
): Promise<Admission> {
  const remoteCause = remoteCauseOf(request);
  if (remoteCause !== undefined && rules.authorize === undefined) {
    return { refused: refused(remoteCause, NOT_OPENED[remoteCause]) };
  }
  const placeCause = placeCauseOf(request, rules.origins);
  if (placeCause !== undefined) return { refused: refused(placeCause, MESSAGES[placeCause]) };
  if (remoteCause === undefined) {
    return rules.tokenMatches(token) ? { admitted: 'local' } : { refused: noToken() };
  }
  return (await authorizes(request, rules))
    ? { admitted: 'remote' }
    : { refused: refused(remoteCause, NOT_ACCEPTED[remoteCause]) };
}

/**
 * Applies the terminal's switch to a request the checks admitted
 * (ADR-0016): `'on'` lets every one through, `'loopback'` only a local
 * one, `'off'` none.
 *
 * @param terminal - The switch.
 * @param reach - Where the admitted request comes from.
 * @returns The `refused` error of cause `terminal-off`; `undefined` when
 * the terminal is open to the request.
 */
export function terminalRefusalOf(
  terminal: 'on' | 'loopback' | 'off',
  reach: Reach,
): CockpitError<'refused'> | undefined {
  if (terminal === 'off') return refused('terminal-off', 'The terminal is turned off.');
  if (terminal === 'loopback' && reach === 'remote') {
    return refused(
      'terminal-off',
      'The terminal is open only to local requests, and this one comes from beyond the machine.',
    );
  }
  return undefined;
}

function remoteCauseOf({ socket, headers }: IncomingMessage): RemoteCause | undefined {
  if (!isLoopbackPeer(socket.remoteAddress)) return 'remote';
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return 'forwarded';
  return undefined;
}

function placeCauseOf(
  { socket, headers }: IncomingMessage,
  origins: readonly string[],
): Extract<RefusalCause, 'local-address' | 'host' | 'origin'> | undefined {
  if (
    isLoopbackPeer(socket.remoteAddress) &&
    !LOOPBACK_ADDRESSES.includes(socket.localAddress ?? '')
  ) {
    return 'local-address';
  }
  if (!isAllowedHost(headers.host, origins)) return 'host';
  if (headers.origin !== undefined && !isAllowedOrigin(headers.origin, origins)) return 'origin';
  return undefined;
}

function isLoopbackPeer(address: string | undefined): boolean {
  return LOOPBACK_PEER.test(address ?? '');
}

function isAllowedHost(host: string | undefined, origins: readonly string[]): boolean {
  if (host === undefined) return false;
  const name = HOST_HEADER.exec(host)?.[1];
  if (name !== undefined && LOCAL_HOST_NAMES.includes(name.toLowerCase())) return true;
  // An origin names its host as a browser's `Host` does: in lower case, its
  // default port left out.
  return origins.some((origin) => new URL(origin).host === host.toLowerCase());
}

function isAllowedOrigin(origin: string, origins: readonly string[]): boolean {
  return isLocalOrigin(origin) || origins.includes(origin);
}

function isLocalOrigin(origin: string): boolean {
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  return (
    (url?.protocol === 'http:' || url?.protocol === 'https:') &&
    LOCAL_HOST_NAMES.includes(url.hostname)
  );
}

/** Whether `authorize` resolves `true`: anything else, a throw included, refuses. */
async function authorizes(request: IncomingMessage, rules: AccessRules): Promise<boolean> {
  try {
    return (await rules.authorize?.(request)) === true;
  } catch (failure) {
    rules.reportAuthorizeFailure(failure);
    return false;
  }
}

const NOT_OPENED: Record<RemoteCause, string> = {
  remote: 'The request comes from beyond the loopback, and the cockpit is not opened to it.',
  forwarded:
    'The request carries a forwarding header: a proxy or tunnel forwarded it, and the cockpit is not opened to remote requests.',
};

const NOT_ACCEPTED: Record<RemoteCause, string> = {
  remote: "The request comes from beyond the loopback, and the app's authorize did not accept it.",
  forwarded:
    "The request carries a forwarding header, so it is remote, and the app's authorize did not accept it.",
};

const MESSAGES: Record<'local-address' | 'host' | 'origin', string> = {
  'local-address': 'The request reaches a local address other than 127.0.0.1 or ::1.',
  host: "The request names a host other than 127.0.0.1, localhost or one of the app's origins.",
  origin:
    "The request comes from a page whose origin is not on 127.0.0.1 or localhost, nor one of the app's origins.",
};

function refused(cause: RefusalCause, message: string): CockpitError<'refused'> {
  return new CockpitError('refused', message, { cause });
}

function noToken(): CockpitError<'no-token'> {
  return new CockpitError(
    'no-token',
    "The request carries no valid token: the person opens the app's link.",
  );
}
