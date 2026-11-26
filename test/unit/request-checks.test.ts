import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  type AccessRules,
  type Admission,
  admissionAfterRenewal,
  admissionOf,
  terminalRefusalOf,
} from '../../src/server/http/request-checks.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

const TOKEN = 'the-token';

interface Facts {
  readonly remoteAddress?: string | undefined;
  readonly localAddress?: string | undefined;
  readonly headers?: IncomingHttpHeaders;
  /** The token the request carried; the app's when left out. */
  readonly token?: string | undefined;
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

/** The rules of a cockpit that records what it asks of the app. */
function rulesOf(
  rules: Partial<Pick<AccessRules, 'origins' | 'authorize'>> = {},
): AccessRules & { readonly asked: IncomingMessage[]; readonly failures: unknown[] } {
  const asked: IncomingMessage[] = [];
  const failures: unknown[] = [];
  const authorize = rules.authorize;
  return {
    origins: rules.origins ?? [],
    ...(authorize === undefined
      ? {}
      : {
          authorize: (given: IncomingMessage) => {
            asked.push(given);
            return authorize(given);
          },
        }),
    tokenMatches: (candidate) => candidate === TOKEN,
    reportAuthorizeFailure: (cause) => failures.push(cause),
    asked,
    failures,
  };
}

async function admit(facts: Facts = {}, rules: AccessRules = rulesOf()): Promise<Admission> {
  return await admissionOf(request(facts), 'token' in facts ? facts.token : TOKEN, rules);
}

async function causeOf(facts: Facts, rules?: AccessRules): Promise<string | undefined> {
  const admission = await admit(facts, rules);
  return 'refused' in admission && isCockpitError(admission.refused, 'refused')
    ? admission.refused.cause
    : undefined;
}

/** A remote peer of the machine's network, at an origin the app allowed. */
const LAN = {
  remoteAddress: '192.168.1.20',
  localAddress: '192.168.1.5',
  headers: { host: '192.168.1.5:8765', origin: 'http://192.168.1.5:8765' },
} as const;
const LAN_ORIGINS = ['http://192.168.1.5:8765'];

describe('the request checks of the loopback-only default', () => {
  it('admit a request from loopback, to loopback, naming a local host, from a local page', async () => {
    expect(await admit()).toEqual({ admitted: 'local' });
    expect(
      await admit({ headers: { host: 'localhost:8765', origin: 'http://localhost:8765' } }),
    ).toEqual({ admitted: 'local' });
  });

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
  ])('admit a loopback peer %s reaching %s', async (remoteAddress, localAddress) => {
    expect(await admit({ remoteAddress, localAddress })).toEqual({ admitted: 'local' });
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
  ])('refuse a peer at %j as remote', async (remoteAddress) => {
    const admission = await admit({ remoteAddress });

    expect('refused' in admission && admission.refused).toMatchObject({
      code: 'refused',
      cause: 'remote',
      message: expect.stringMatching(/beyond the loopback.*not opened/),
    });
  });

  it('refuses a request whose socket has no peer address any more, as remote', async () => {
    expect(await causeOf({ remoteAddress: undefined })).toBe('remote');
  });

  it.each([
    ['forwarded', { forwarded: 'for=192.0.2.60;proto=http' }],
    ['x-forwarded-for', { 'x-forwarded-for': '192.0.2.60' }],
    ['x-real-ip', { 'x-real-ip': '192.0.2.60' }],
    ['an empty x-forwarded-for', { 'x-forwarded-for': '' }],
  ])('refuse a loopback request that carries %s, as forwarded', async (_what, header) => {
    expect(await causeOf({ headers: { host: '127.0.0.1:8765', ...header } })).toBe('forwarded');
  });

  it.each(['127.0.0.2', '127.1.2.3', '::ffff:127.0.0.2', '192.168.1.20', undefined])(
    'refuse a loopback request that reaches %s, as local-address',
    async (localAddress) => {
      expect(await causeOf({ remoteAddress: '127.0.0.2', localAddress })).toBe('local-address');
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
  ])('refuse a Host of %j, as host', async (host) => {
    expect(await causeOf({ headers: host === undefined ? {} : { host } })).toBe('host');
  });

  it.each(['127.0.0.1', '127.0.0.1:1', 'localhost', 'LOCALHOST:8765'])(
    'admit a Host of %j, any port',
    async (host) => {
      expect(await admit({ headers: { host } })).toEqual({ admitted: 'local' });
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
  ])('refuse an Origin of %j, as origin', async (origin) => {
    expect(await causeOf({ headers: { host: '127.0.0.1:8765', origin } })).toBe('origin');
  });

  it.each(['http://127.0.0.1:3000', 'https://localhost', 'http://localhost:8765'])(
    'admit an Origin of %j, any port',
    async (origin) => {
      expect(await admit({ headers: { host: '127.0.0.1:8765', origin } })).toEqual({
        admitted: 'local',
      });
    },
  );

  it('name the first check that fails, in the order of the design', async () => {
    const everything = {
      remoteAddress: '192.168.1.20',
      localAddress: '127.0.0.2',
      headers: { 'x-forwarded-for': '1.2.3.4', host: 'evil', origin: 'http://evil' },
    };
    expect(await causeOf(everything)).toBe('remote');
    expect(await causeOf({ ...everything, remoteAddress: '127.0.0.2' })).toBe('forwarded');
    expect(
      await causeOf({ ...everything, remoteAddress: '127.0.0.2', headers: { host: 'evil' } }),
    ).toBe('local-address');
    expect(await causeOf({ headers: { host: 'evil', origin: 'http://evil' } })).toBe('host');
  });
});

describe('the token, on a local request', () => {
  it.each([undefined, '', 'another'])('refuses %j with no-token', async (token) => {
    const admission = await admit({ token });

    expect('refused' in admission && isCockpitError(admission.refused, 'no-token')).toBe(true);
    expect('refused' in admission && admission.refused.message).toMatch(/link/);
  });

  it('is asked after the request checks: a refused request is told its cause, not the token', async () => {
    expect(await causeOf({ token: undefined, headers: { host: 'evil.example' } })).toBe('host');
  });
});

describe('an admission checked again after a renewal of the token', () => {
  const renewed = { tokenMatches: (candidate: string | undefined) => candidate === 'new-token' };

  it('keeps a local request admitted by the old token out: no-token', () => {
    const admission = admissionAfterRenewal({ admitted: 'local' }, TOKEN, renewed);

    expect('refused' in admission && isCockpitError(admission.refused, 'no-token')).toBe(true);
  });

  it('keeps a local request in that carries the new token', () => {
    expect(admissionAfterRenewal({ admitted: 'local' }, 'new-token', renewed)).toEqual({
      admitted: 'local',
    });
  });

  it('keeps the verdict authorize gave a remote request, which no token made', () => {
    expect(admissionAfterRenewal({ admitted: 'remote' }, undefined, renewed)).toEqual({
      admitted: 'remote',
    });
  });

  it('lets a refusal stand', async () => {
    const refused = await admit({ token: undefined });

    expect(admissionAfterRenewal(refused, 'new-token', renewed)).toBe(refused);
  });
});

describe('the allowed origins, beyond 127.0.0.1 and localhost', () => {
  const origins = ['https://app.example', 'http://10.0.0.5:8765', 'http://[fe80::1]:8765'];

  it.each([
    ['https://app.example', 'app.example'],
    ['http://10.0.0.5:8765', '10.0.0.5:8765'],
    ['http://[fe80::1]:8765', '[fe80::1]:8765'],
  ])('admit an Origin of %j that the app allowed, and a Host of %j', async (origin, host) => {
    expect(await admit({ headers: { host, origin } }, rulesOf({ origins }))).toEqual({
      admitted: 'local',
    });
  });

  it.each(['APP.EXAMPLE', 'App.Example'])(
    'admit a Host of %j, host names being of any case',
    async (host) => {
      expect(await admit({ headers: { host } }, rulesOf({ origins }))).toEqual({
        admitted: 'local',
      });
    },
  );

  it.each([
    'app.example:8443',
    'app.example:443',
    '10.0.0.5',
    '10.0.0.5:8766',
    'other.app.example',
    '[fe80::1]',
  ])('refuse a Host of %j, another host or another port than an entry names', async (host) => {
    expect(await causeOf({ headers: { host } }, rulesOf({ origins }))).toBe('host');
  });

  it.each([
    'http://app.example',
    'https://app.example:8443',
    'https://app.example/',
    'https://other.app.example',
    'http://10.0.0.5:8766',
    'https://10.0.0.5:8765',
  ])('refuse an Origin of %j, which no entry is exactly', async (origin) => {
    expect(await causeOf({ headers: { host: 'app.example', origin } }, rulesOf({ origins }))).toBe(
      'origin',
    );
  });

  it('keep 127.0.0.1 and localhost allowed beside them', async () => {
    expect(
      await admit(
        { headers: { host: 'localhost:3000', origin: 'http://127.0.0.1:3000' } },
        rulesOf({ origins }),
      ),
    ).toEqual({ admitted: 'local' });
  });

  it('open nothing by themselves: a remote request at an allowed origin is still refused', async () => {
    expect(await causeOf(LAN, rulesOf({ origins: LAN_ORIGINS }))).toBe('remote');
  });
});

describe('opening beyond the loopback with the app’s authorize', () => {
  const accept = () => true;

  it.each([
    ['true', () => true],
    ['a promise of true', async () => true],
  ])('admits a remote request when authorize gives %s, with no token', async (_what, authorize) => {
    const rules = rulesOf({ origins: LAN_ORIGINS, authorize });

    expect(await admit({ ...LAN, token: undefined }, rules)).toEqual({ admitted: 'remote' });
    expect(rules.asked).toHaveLength(1);
  });

  it('admits a forwarded request the same way, and gives authorize the request itself', async () => {
    const rules = rulesOf({ authorize: accept });
    const forwarded = request({ headers: { host: '127.0.0.1:8765', 'x-real-ip': '192.0.2.1' } });

    expect(await admissionOf(forwarded, undefined, rules)).toEqual({ admitted: 'remote' });
    expect(rules.asked).toEqual([forwarded]);
  });

  it.each([
    ['false', () => false],
    ['a promise of false', async () => false],
    ['something else than true', () => 'yes' as unknown as boolean],
  ])(
    'refuses a remote request when authorize gives %s, as remote, saying the app refused it',
    async (_what, authorize) => {
      const rules = rulesOf({ origins: LAN_ORIGINS, authorize });
      const admission = await admit({ ...LAN, token: TOKEN }, rules);

      expect('refused' in admission && admission.refused).toMatchObject({
        code: 'refused',
        cause: 'remote',
        message: expect.stringMatching(/app's authorize did not accept/),
      });
      expect(rules.failures).toEqual([]);
    },
  );

  it('refuses a forwarded request authorize does not accept, as forwarded', async () => {
    const admission = await admit(
      { headers: { host: '127.0.0.1:8765', forwarded: 'for=192.0.2.1' } },
      rulesOf({ authorize: () => false }),
    );

    expect('refused' in admission && admission.refused).toMatchObject({
      code: 'refused',
      cause: 'forwarded',
      message: expect.stringMatching(/app's authorize did not accept/),
    });
  });

  it.each([
    [
      'throws',
      (failure: Error) => () => {
        throw failure;
      },
    ],
    ['rejects', (failure: Error) => () => Promise.reject(failure)],
  ])(
    'refuses a remote request when authorize %s, and reports the failure to the app',
    async (_what, failing) => {
      const failure = new Error('the app’s store is down');
      const rules = rulesOf({ origins: LAN_ORIGINS, authorize: failing(failure) });

      expect(await causeOf(LAN, rules)).toBe('remote');
      expect(rules.failures).toEqual([failure]);
    },
  );

  it('never asks authorize for a local request: it needs the token, authorize or not', async () => {
    const rules = rulesOf({ authorize: accept });

    const admission = await admit({ token: undefined }, rules);
    expect('refused' in admission && admission.refused.code).toBe('no-token');
    expect(await admit({}, rules)).toEqual({ admitted: 'local' });
    expect(rules.asked).toEqual([]);
  });

  it.each([
    ['a Host outside the allowed set', { ...LAN, headers: { host: 'evil.example' } }, 'host'],
    [
      'an Origin outside the allowed set',
      { ...LAN, headers: { ...LAN.headers, origin: 'http://evil.example' } },
      'origin',
    ],
    [
      'the machine’s address, not an allowed origin',
      { ...LAN, headers: { host: '192.168.1.5:9999' } },
      'host',
    ],
    [
      'a loopback peer reaching another 127.x address, forwarded',
      {
        remoteAddress: '127.0.0.1',
        localAddress: '127.0.0.2',
        headers: { host: '127.0.0.1', 'x-forwarded-for': '1.2.3.4' },
      },
      'local-address',
    ],
  ])('refuses a remote request with %s before authorize is asked', async (_what, facts, cause) => {
    const rules = rulesOf({ origins: LAN_ORIGINS, authorize: accept });

    expect(await causeOf(facts, rules)).toBe(cause);
    expect(rules.asked).toEqual([]);
  });

  it('refuses a loopback request reaching another 127.x address, authorize or not', async () => {
    const rules = rulesOf({ authorize: accept });

    expect(await causeOf({ remoteAddress: '127.0.0.1', localAddress: '127.0.0.2' }, rules)).toBe(
      'local-address',
    );
    expect(rules.asked).toEqual([]);
  });
});

describe('the terminal’s switch', () => {
  it.each([
    ['on', 'local'],
    ['on', 'remote'],
    ['loopback', 'local'],
  ] as const)('%s lets a %s request through', (terminal, reach) => {
    expect(terminalRefusalOf(terminal, reach)).toBeUndefined();
  });

  it('loopback refuses a remote request: terminal-off, saying the terminal is local only', () => {
    expect(terminalRefusalOf('loopback', 'remote')).toMatchObject({
      code: 'refused',
      cause: 'terminal-off',
      message: expect.stringMatching(/only to local requests/),
    });
  });

  it.each(['local', 'remote'] as const)('off refuses a %s request: terminal-off', (reach) => {
    expect(terminalRefusalOf('off', reach)).toMatchObject({
      code: 'refused',
      cause: 'terminal-off',
      message: expect.stringMatching(/turned off/),
    });
  });
});
