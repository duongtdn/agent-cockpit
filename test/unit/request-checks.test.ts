import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { refusalOf, tokenRefusalOf } from '../../src/server/http/request-checks.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

interface Facts {
  readonly remoteAddress?: string | undefined;
  readonly localAddress?: string | undefined;
  readonly headers?: IncomingHttpHeaders;
}

/** A request as the checks read it: its socket's two addresses and its headers. */
function request(facts: Facts = {}): IncomingMessage {
  const { remoteAddress, localAddress, headers } = {
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    headers: { host: '127.0.0.1:8765' },
    ...facts,
  };
  return { socket: { remoteAddress, localAddress }, headers } as unknown as IncomingMessage;
}

function causeOf(facts: Facts): string | undefined {
  return refusalOf(request(facts))?.cause;
}

describe('the request checks of the loopback-only default', () => {
  it('pass a request from loopback, to loopback, naming a local host, from a local page', () => {
    expect(refusalOf(request())).toBeUndefined();
    expect(
      causeOf({ headers: { host: 'localhost:8765', origin: 'http://localhost:8765' } }),
    ).toBeUndefined();
  });

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
  ])('pass a loopback peer %s reaching %s', (remoteAddress, localAddress) => {
    expect(causeOf({ remoteAddress, localAddress })).toBeUndefined();
  });

  it.each([
    '192.168.1.20',
    '10.0.0.1',
    '::ffff:192.168.1.20',
    'fe80::1',
    '2001:db8::1',
    '128.0.0.1',
    '::2',
    '',
  ])('refuse a peer at %j as remote', (remoteAddress) => {
    const refusal = refusalOf(request({ remoteAddress }));

    expect(isCockpitError(refusal, 'refused')).toBe(true);
    expect(refusal?.cause).toBe('remote');
    expect(refusal?.message).toMatch(/beyond the loopback/);
  });

  it('refuses a request whose socket has no peer address any more, as remote', () => {
    expect(causeOf({ remoteAddress: undefined })).toBe('remote');
  });

  it.each([
    ['forwarded', { forwarded: 'for=192.0.2.60;proto=http' }],
    ['x-forwarded-for', { 'x-forwarded-for': '192.0.2.60' }],
    ['x-real-ip', { 'x-real-ip': '192.0.2.60' }],
    ['an empty x-forwarded-for', { 'x-forwarded-for': '' }],
  ])('refuse a loopback request that carries %s, as forwarded', (_what, header) => {
    expect(causeOf({ headers: { host: '127.0.0.1:8765', ...header } })).toBe('forwarded');
  });

  it.each(['127.0.0.2', '127.1.2.3', '::ffff:127.0.0.2', '192.168.1.20', undefined])(
    'refuse a loopback request that reaches %s, as local-address',
    (localAddress) => {
      expect(causeOf({ remoteAddress: '127.0.0.2', localAddress })).toBe('local-address');
    },
  );

  it.each([
    'evil.example',
    'evil.example:8765',
    'localhost.evil.example',
    '127.0.0.1.nip.io',
    '[::1]:8765',
    '0.0.0.0:8765',
    '127.0.0.1:',
    '127.0.0.1:port',
    '',
    undefined,
  ])('refuse a Host of %j, as host', (host) => {
    expect(causeOf({ headers: host === undefined ? {} : { host } })).toBe('host');
  });

  it.each(['127.0.0.1', '127.0.0.1:1', 'localhost', 'LOCALHOST:8765'])(
    'pass a Host of %j, any port',
    (host) => {
      expect(causeOf({ headers: { host } })).toBeUndefined();
    },
  );

  it.each([
    'http://evil.example',
    'http://localhost.evil.example:8765',
    'null',
    'file://',
    'chrome-extension://abc',
    'http://[::1]:8765',
    'not a url',
  ])('refuse an Origin of %j, as origin', (origin) => {
    expect(causeOf({ headers: { host: '127.0.0.1:8765', origin } })).toBe('origin');
  });

  it.each(['http://127.0.0.1:3000', 'https://localhost', 'http://localhost:8765'])(
    'pass an Origin of %j, any port',
    (origin) => {
      expect(causeOf({ headers: { host: '127.0.0.1:8765', origin } })).toBeUndefined();
    },
  );

  it('name the first check that fails, in the order of the design', () => {
    const everything = {
      remoteAddress: '192.168.1.20',
      localAddress: '127.0.0.2',
      headers: { 'x-forwarded-for': '1.2.3.4', host: 'evil', origin: 'http://evil' },
    };
    expect(causeOf(everything)).toBe('remote');
    expect(causeOf({ ...everything, remoteAddress: '127.0.0.2' })).toBe('forwarded');
    expect(causeOf({ ...everything, remoteAddress: '127.0.0.2', headers: { host: 'evil' } })).toBe(
      'local-address',
    );
    expect(causeOf({ headers: { host: 'evil', origin: 'http://evil' } })).toBe('host');
  });
});

describe('the token check', () => {
  const matches = (candidate: string | undefined) => candidate === 'the-token';

  it('passes the app’s token', () => {
    expect(tokenRefusalOf('the-token', matches)).toBeUndefined();
  });

  it.each([undefined, '', 'another'])('refuses %j with no-token', (candidate) => {
    const refusal = tokenRefusalOf(candidate, matches);

    expect(isCockpitError(refusal, 'no-token')).toBe(true);
    expect(refusal?.message).toMatch(/link/);
  });
});
