import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createHandler, type Handler, type HandlerOptions } from '../../src/server/http/handler.ts';
import { headerToken, subprotocolToken } from '../../src/server/http/request-token.ts';
import type { Attachment } from '../../src/server/session-host/session-host.ts';
import type { Session } from '../../src/shared/session.ts';
import { eventually } from '../support/eventually.ts';
import {
  baseUrlOf,
  type CallOptions,
  call,
  type OpenSocket,
  openedSocket,
  openSocket,
  post,
} from '../support/wire-client.ts';

/**
 * The browser-facing rows of the security design, on `node:http`: each
 * request on every surface — control, observation, the terminal — over
 * HTTP and over a WebSocket handshake, through the real checks and the
 * real token.
 */

const TOKEN = 'the-apps-token';
const idle: Session = { key: 'explain-a', state: 'idle', since: '2026-11-26T00:00:00.000Z' };

/** An address of this machine beyond the loopback, where a request comes from the network. */
function networkAddress(): string {
  const found = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal);
  if (found === undefined) throw new Error('The test needs an IPv4 address beyond the loopback.');
  return found.address;
}

/** A terminal attached to a session that records whether it was detached. */
class QuietAttachment implements Attachment {
  detached = false;
  onData() {
    return () => {};
  }
  onEnd() {
    return () => {};
  }
  write() {}
  resize() {}
  async detach() {
    this.detached = true;
  }
}

type Access = Partial<Pick<HandlerOptions, 'authorize' | 'origins' | 'terminal'>>;

/** One handler, served at three addresses: loopback, the network's, and another `127.x`. */
interface Served {
  readonly handler: Handler;
  /** `http://127.0.0.1:<port>` */
  readonly local: string;
  /** `http://<the machine's network address>:<port>`: a request to it is remote. */
  readonly lan: string;
  /** `http://127.0.0.2:<port>`: a loopback request to another local address. */
  readonly other: string;
  readonly asked: IncomingMessage[];
  readonly failures: { where: string; cause: unknown }[];
  readonly attachments: QuietAttachment[];
  /**
   * Renews the app's token through the handler: `putInForce` is awaited
   * before the new token is in force, so that a test can hold the renewal
   * under way.
   */
  renewToken(next: string, putInForce?: Promise<void>): Promise<void>;
  /** Whether a request carries the token in force, as the app's `cockpit.verify` tells. */
  verify(request: IncomingMessage): boolean;
  /** Closes the servers as an app does, waiting for every connection to end. */
  closeServers(): Promise<void>;
}

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/**
 * Serves a handler with the access options a test gives. `origins` may
 * name the network address's origin before its port is known: a function
 * of it.
 */
async function serve(
  access: Omit<Access, 'origins'> & { origins?: (lan: string) => string[] } = {},
): Promise<Served> {
  let handler: Handler | undefined;
  const asked: IncomingMessage[] = [];
  const failures: { where: string; cause: unknown }[] = [];
  const attachments: QuietAttachment[] = [];
  const servers: Server[] = [];
  const listen = async (address: string): Promise<string> => {
    const server: Server = createServer((request, response) => handler?.handle(request, response));
    server.on('upgrade', (request, socket, head) => handler?.upgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, address, resolve));
    servers.push(server);
    stops.push(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    return baseUrlOf(server.address() as AddressInfo);
  };
  const [local, lan, other] = [
    await listen('127.0.0.1'),
    await listen(networkAddress()),
    await listen('127.0.0.2'),
  ];
  const authorize = access.authorize;
  let token = TOKEN;
  handler = createHandler({
    tokenMatches: (candidate) => candidate === token,
    operations: {
      run: async () => ({ action: 'started', state: 'busy' }),
      send: async () => ({ action: 'sent', state: 'busy' }),
      open: async () => ({ action: 'nothing-to-open' }),
      jobs: () => [],
      options: async () => [],
    },
    sessions: {
      list: () => [idle],
      follow(listener) {
        listener([idle]);
        return () => {};
      },
    },
    terminals: {
      attach: async () => {
        const attachment = new QuietAttachment();
        attachments.push(attachment);
        return attachment;
      },
      isLive: async () => true,
      joinHold: () => () => {},
    },
    keyRules: [],
    ...(authorize === undefined
      ? {}
      : {
          authorize: (request: IncomingMessage) => {
            asked.push(request);
            return authorize(request);
          },
        }),
    origins: access.origins?.(lan) ?? [],
    terminal: access.terminal ?? 'on',
    reportFailure: (where, cause) => failures.push({ where, cause }),
  });
  const served = handler;
  stops.push(() => served.close());
  const closeServers = async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  };
  const renewToken = (next: string, putInForce = Promise.resolve()) =>
    served.renewToken(async () => {
      await putInForce;
      token = next;
    });
  const verify = (request: IncomingMessage) =>
    (headerToken(request) ?? subprotocolToken(request)) === token;
  return {
    handler,
    local,
    lan,
    other,
    asked,
    failures,
    attachments,
    renewToken,
    verify,
    closeServers,
  };
}

const ws = (base: string, path: string) => `${base.replace('http', 'ws')}${path}`;

/** What a surface answered: a status — 101 for a handshake that opened — and the error, if any. */
interface Outcome {
  readonly status: number;
  readonly error?: Record<string, unknown>;
}

function outcomeOf(reply: { status: number; body: string }): Outcome {
  if (reply.body === '' || reply.status < 400) return { status: reply.status };
  const { error } = JSON.parse(reply.body) as { error: Record<string, unknown> };
  return { status: reply.status, error };
}

async function handshake(url: string, options: CallOptions): Promise<Outcome> {
  const outcome = await openSocket(url, options);
  if ('open' in outcome) {
    outcome.open.socket.close();
    return { status: 101 };
  }
  if ('refused' in outcome) return outcomeOf(outcome.refused);
  return { status: 0 };
}

/** Each browser-facing surface, by HTTP and by handshake, with what it answers when served. */
const SURFACES = {
  'control: POST run': {
    served: 200,
    ask: async (base: string, options: CallOptions) =>
      outcomeOf(await post(`${base}/run`, { jobId: 'explain', args: {} }, options)),
  },
  'observation: GET sessions': {
    served: 200,
    ask: async (base: string, options: CallOptions) =>
      outcomeOf(await call(`${base}/sessions`, options)),
  },
  'observation: the sessions’ WebSocket': {
    served: 101,
    ask: (base: string, options: CallOptions) => handshake(ws(base, '/follow/sessions'), options),
  },
  'terminal: its HTTP probe': {
    served: 426,
    ask: async (base: string, options: CallOptions) =>
      outcomeOf(await call(`${base}/terminal/explain-a`, options)),
  },
  'terminal: its WebSocket': {
    served: 101,
    ask: (base: string, options: CallOptions) =>
      handshake(ws(base, '/terminal/explain-a'), options),
  },
} as const;

type SurfaceName = keyof typeof SURFACES;
const ALL = Object.keys(SURFACES) as SurfaceName[];
const TERMINAL: SurfaceName[] = ['terminal: its HTTP probe', 'terminal: its WebSocket'];
const NOT_TERMINAL = ALL.filter((name) => !TERMINAL.includes(name));

/** Asks every named surface the same, and gives each answer by the surface's name. */
async function everySurface(
  names: readonly SurfaceName[],
  base: string,
  options: CallOptions,
): Promise<Record<string, Outcome>> {
  const outcomes: Record<string, Outcome> = {};
  for (const name of names) outcomes[name] = await SURFACES[name].ask(base, options);
  return outcomes;
}

function served(names: readonly SurfaceName[]): Record<string, Outcome> {
  return Object.fromEntries(names.map((name) => [name, { status: SURFACES[name].served }]));
}

function refusedAll(names: readonly SurfaceName[], error: Record<string, unknown>) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        status: error.code === 'no-token' ? 401 : 403,
        error: expect.objectContaining({ name: 'CockpitError', ...error }),
      },
    ]),
  );
}

const lanOrigin = (lan: string) => [lan];
const forwarded = { 'x-forwarded-for': '192.0.2.1' };

describe('the loopback-only default: no authorize', () => {
  it('serves a local request with the token, on every surface', async () => {
    const { local } = await serve();

    expect(await everySurface(ALL, local, { token: TOKEN })).toEqual(served(ALL));
  });

  it('refuses a local request without the token, or with another: no-token, 401', async () => {
    const { local } = await serve();

    for (const token of [undefined, 'another']) {
      expect(await everySurface(ALL, local, token === undefined ? {} : { token })).toEqual(
        refusedAll(ALL, { code: 'no-token' }),
      );
    }
  });

  it('refuses a request from beyond the loopback, even with the token and an allowed origin: remote', async () => {
    const { lan } = await serve({ origins: lanOrigin });

    expect(await everySurface(ALL, lan, { token: TOKEN })).toEqual(
      refusedAll(ALL, {
        code: 'refused',
        cause: 'remote',
        message: expect.stringMatching(/not opened/),
      }),
    );
  });

  it.each([
    ['X-Forwarded-For', { 'x-forwarded-for': '192.0.2.1' }],
    ['Forwarded', { forwarded: 'for=192.0.2.1' }],
    ['X-Real-IP', { 'x-real-ip': '192.0.2.1' }],
  ])(
    'refuses a loopback request a proxy forwarded, with %s, even with the token: forwarded',
    async (_what, headers) => {
      const { local } = await serve();

      expect(await everySurface(ALL, local, { token: TOKEN, headers })).toEqual(
        refusedAll(ALL, { code: 'refused', cause: 'forwarded' }),
      );
    },
  );

  it('refuses a loopback request to another 127.x address, even with the token: local-address', async () => {
    const { other } = await serve();

    expect(
      await everySurface(ALL, other, { token: TOKEN, headers: { host: '127.0.0.1' } }),
    ).toEqual(refusedAll(ALL, { code: 'refused', cause: 'local-address' }));
  });

  it.each([
    ['an Origin of another site', { origin: 'http://evil.example' }, 'origin'],
    ['a Host of another name, as DNS rebinding gives', { host: 'evil.example:80' }, 'host'],
  ])('refuses a request with %s, even with the token', async (_what, headers, cause) => {
    const { local } = await serve();

    expect(await everySurface(ALL, local, { token: TOKEN, headers })).toEqual(
      refusedAll(ALL, { code: 'refused', cause }),
    );
  });
});

describe('the allowed origins', () => {
  it('admit a local request whose Origin is one of them, and whose Host names one', async () => {
    const { local } = await serve({ origins: () => ['https://app.example'] });

    expect(
      await everySurface(ALL, local, {
        token: TOKEN,
        headers: { host: 'app.example', origin: 'https://app.example' },
      }),
    ).toEqual(served(ALL));
  });

  it('refuse a Host naming an entry’s host at another port, and an Origin no entry is', async () => {
    const { local } = await serve({ origins: () => ['https://app.example'] });

    expect(
      await everySurface(ALL, local, { token: TOKEN, headers: { host: 'app.example:8443' } }),
    ).toEqual(refusedAll(ALL, { code: 'refused', cause: 'host' }));
    expect(
      await everySurface(ALL, local, {
        token: TOKEN,
        headers: { host: 'app.example', origin: 'http://app.example' },
      }),
    ).toEqual(refusedAll(ALL, { code: 'refused', cause: 'origin' }));
  });
});

describe('opened beyond the loopback by the app’s authorize', () => {
  it.each([
    ['true', () => true],
    ['a promise of true', async () => true],
  ])(
    'serves a remote request, without the token, when authorize gives %s',
    async (_what, authorize) => {
      const { lan, asked } = await serve({ authorize, origins: lanOrigin });

      expect(await everySurface(ALL, lan, {})).toEqual(served(ALL));
      expect(asked).toHaveLength(ALL.length);
    },
  );

  it('serves a forwarded request, without the token, when authorize accepts it', async () => {
    const { local } = await serve({ authorize: () => true });

    expect(await everySurface(ALL, local, { headers: forwarded })).toEqual(served(ALL));
  });

  it.each([
    ['false', () => false],
    ['a promise of false', async () => false],
  ])(
    'refuses a remote request when authorize gives %s, with its own cause: the app refused it',
    async (_what, authorize) => {
      const { local, lan } = await serve({ authorize, origins: lanOrigin });
      const refusedByTheApp = (cause: string) =>
        refusedAll(ALL, {
          code: 'refused',
          cause,
          message: expect.stringMatching(/authorize did not accept/),
        });

      expect(await everySurface(ALL, lan, { token: TOKEN })).toEqual(refusedByTheApp('remote'));
      expect(await everySurface(ALL, local, { token: TOKEN, headers: forwarded })).toEqual(
        refusedByTheApp('forwarded'),
      );
    },
  );

  it.each([
    [
      'throws',
      (failure: Error) => () => {
        throw failure;
      },
    ],
    ['rejects', (failure: Error) => () => Promise.reject(failure)],
  ])(
    'refuses a remote request when authorize %s — fail closed — and reports it to the app, never on the wire',
    async (_what, failing) => {
      const failure = new Error('secret detail of the app');
      const { lan, failures } = await serve({ authorize: failing(failure), origins: lanOrigin });

      const outcomes = await everySurface(ALL, lan, {});

      expect(outcomes).toEqual(refusedAll(ALL, { code: 'refused', cause: 'remote' }));
      expect(JSON.stringify(outcomes)).not.toContain('secret');
      expect(failures).toEqual(ALL.map(() => ({ where: 'authorize', cause: failure })));
    },
  );

  it('still needs the token from a local request, and never asks authorize of it', async () => {
    const { local, asked } = await serve({ authorize: () => true });

    expect(await everySurface(ALL, local, {})).toEqual(refusedAll(ALL, { code: 'no-token' }));
    expect(await everySurface(ALL, local, { token: TOKEN })).toEqual(served(ALL));
    expect(asked).toEqual([]);
  });

  it('treats a request through a proxy that adds no header as local: the token, never authorize', async () => {
    // A raw TCP tunnel, or nginx as shipped, arrives from loopback with no forwarding header.
    const { local, asked } = await serve({ authorize: () => true });

    expect(await everySurface(ALL, local, { headers: { host: '127.0.0.1:8765' } })).toEqual(
      refusedAll(ALL, { code: 'no-token' }),
    );
    expect(asked).toEqual([]);
  });

  it('refuses a loopback request to another 127.x address, authorize or not: local-address', async () => {
    const { other, asked } = await serve({ authorize: () => true });

    for (const headers of [{ host: '127.0.0.1' }, { host: '127.0.0.1', ...forwarded }]) {
      expect(await everySurface(ALL, other, { headers })).toEqual(
        refusedAll(ALL, { code: 'refused', cause: 'local-address' }),
      );
    }
    expect(asked).toEqual([]);
  });

  it('checks Host and Origin before authorize is asked', async () => {
    const { lan, asked } = await serve({ authorize: () => true, origins: lanOrigin });

    expect(await everySurface(ALL, lan, { headers: { host: 'evil.example' } })).toEqual(
      refusedAll(ALL, { code: 'refused', cause: 'host' }),
    );
    expect(await everySurface(ALL, lan, { headers: { origin: 'http://evil.example' } })).toEqual(
      refusedAll(ALL, { code: 'refused', cause: 'origin' }),
    );
    expect(asked).toEqual([]);
  });

  it('refuses the machine’s own address as a Host while the app has not allowed its origin', async () => {
    const { lan, asked } = await serve({ authorize: () => true });

    expect(await everySurface(ALL, lan, {})).toEqual(
      refusedAll(ALL, { code: 'refused', cause: 'host' }),
    );
    expect(asked).toEqual([]);
  });
});

describe('the terminal’s switch', () => {
  it('off refuses every terminal request, its probe included, local ones too: terminal-off; the rest is served', async () => {
    const { local, lan } = await serve({
      terminal: 'off',
      authorize: () => true,
      origins: lanOrigin,
    });
    const off = refusedAll(TERMINAL, {
      code: 'refused',
      cause: 'terminal-off',
      message: expect.stringMatching(/turned off/),
    });

    expect(await everySurface(TERMINAL, local, { token: TOKEN })).toEqual(off);
    expect(await everySurface(TERMINAL, lan, {})).toEqual(off);
    expect(await everySurface(NOT_TERMINAL, local, { token: TOKEN })).toEqual(served(NOT_TERMINAL));
    expect(await everySurface(NOT_TERMINAL, lan, {})).toEqual(served(NOT_TERMINAL));
  });

  it('off still tells a request the checks refuse why: its cause, not the switch', async () => {
    const { local } = await serve({ terminal: 'off' });

    expect(await everySurface(TERMINAL, local, {})).toEqual(
      refusedAll(TERMINAL, { code: 'no-token' }),
    );
    expect(await everySurface(TERMINAL, local, { token: TOKEN, headers: forwarded })).toEqual(
      refusedAll(TERMINAL, { code: 'refused', cause: 'forwarded' }),
    );
  });

  it('loopback refuses a remote terminal request authorize accepted: terminal-off; serves a local one and the rest', async () => {
    const { local, lan } = await serve({
      terminal: 'loopback',
      authorize: () => true,
      origins: lanOrigin,
    });
    const localOnly = refusedAll(TERMINAL, {
      code: 'refused',
      cause: 'terminal-off',
      message: expect.stringMatching(/only to local requests/),
    });

    expect(await everySurface(TERMINAL, lan, {})).toEqual(localOnly);
    expect(await everySurface(TERMINAL, local, { headers: forwarded })).toEqual(localOnly);
    expect(await everySurface(TERMINAL, local, { token: TOKEN })).toEqual(served(TERMINAL));
    expect(await everySurface(NOT_TERMINAL, lan, {})).toEqual(served(NOT_TERMINAL));
  });

  it('loopback leaves a remote request authorize refused to its own cause', async () => {
    const { lan } = await serve({
      terminal: 'loopback',
      authorize: () => false,
      origins: lanOrigin,
    });

    expect(await everySurface(TERMINAL, lan, {})).toEqual(
      refusedAll(TERMINAL, { code: 'refused', cause: 'remote' }),
    );
  });

  it('on serves a remote terminal request authorize accepted', async () => {
    const { lan } = await serve({ terminal: 'on', authorize: () => true, origins: lanOrigin });

    expect(await everySurface(TERMINAL, lan, {})).toEqual(served(TERMINAL));
  });
});

/** A promise a test settles when it chooses: an `authorize`'s lookup, a renewal's write. */
function gate<T>(): { readonly promise: Promise<T>; open(value: T): void } {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The answer to a request whose admission overlapped a renewal of the
 * token: 503, `Retry-After`, and the wire's body that asks for it to be
 * made again, which the client tells from an error.
 */
const RETRY_LATER = {
  status: 503,
  headers: expect.objectContaining({ 'retry-after': '1', 'content-type': 'application/json' }),
  body: JSON.stringify({ retry: true }),
};

/** What refused a handshake, its status and headers; `undefined` for one that opened. */
async function handshakeRefusal(url: string, options: CallOptions) {
  const outcome = await openSocket(url, options);
  if ('open' in outcome) outcome.open.socket.close();
  return 'refused' in outcome ? outcome.refused : undefined;
}

describe('a renewal of the token', () => {
  async function openTerminal(base: string, options: CallOptions): Promise<OpenSocket> {
    const terminal = await openedSocket(ws(base, '/terminal/explain-a'), options);
    terminal.socket.send(JSON.stringify({ type: 'resize', columns: 80, rows: 24 }));
    await terminal.next(() => true);
    return terminal;
  }

  /**
   * An app that opens remote access by the link and looks the person up
   * besides: `verify` passes at once, the lookup waits on the test.
   */
  async function serveVerifyThenLookUp() {
    const lookup = gate<boolean>();
    const served: Served = await serve({
      authorize: async (request) => served.verify(request) && (await lookup.promise),
      origins: lanOrigin,
    });
    return { ...served, lookup };
  }

  it('closes every socket, local and remote, detaches every terminal, and goes on serving with the new token', async () => {
    const { renewToken, local, lan, attachments } = await serve({
      authorize: () => true,
      origins: lanOrigin,
    });
    const sockets = [
      await openedSocket(ws(local, '/follow/sessions'), { token: TOKEN }),
      await openedSocket(ws(lan, '/follow/sessions'), {}),
      await openTerminal(local, { token: TOKEN }),
      await openTerminal(lan, {}),
    ];

    await renewToken('the-new-token');

    expect(attachments.map((attachment) => attachment.detached)).toEqual([true, true]);
    for (const opened of sockets) await opened.closed;
    expect(await everySurface(ALL, local, { token: 'the-new-token' })).toEqual(served(ALL));
    expect(await everySurface(ALL, local, { token: TOKEN })).toEqual(
      refusedAll(ALL, { code: 'no-token' }),
    );
  });

  it('refuses a remote request verify passed with the old token while authorize was still out: 503 to retry, authorize asked once; the next attempt is asked afresh', async () => {
    const { renewToken, lan, asked, lookup } = await serveVerifyThenLookUp();
    const answer = call(`${lan}/sessions`, { token: TOKEN });
    await eventually(() => expect(asked).toHaveLength(1));

    await renewToken('the-new-token');
    lookup.open(true);

    expect(await answer).toMatchObject(RETRY_LATER);
    expect(asked).toHaveLength(1);
    expect((await call(`${lan}/sessions`, { token: 'the-new-token' })).status).toBe(200);
    expect((await call(`${lan}/sessions`, { token: TOKEN })).status).toBe(403);
    expect(asked).toHaveLength(3);
  });

  it('refuses a remote terminal handshake verify passed with the old token while authorize was still out: 503 to retry, no shell; the next attempt is asked afresh', async () => {
    const { renewToken, lan, asked, attachments, lookup } = await serveVerifyThenLookUp();
    const refusal = handshakeRefusal(ws(lan, '/terminal/explain-a'), { token: TOKEN });
    await eventually(() => expect(asked).toHaveLength(1));

    await renewToken('the-new-token');
    lookup.open(true);

    expect(await refusal).toMatchObject(RETRY_LATER);
    expect(asked).toHaveLength(1);
    expect(attachments).toEqual([]);
    (await openTerminal(lan, { token: 'the-new-token' })).socket.close();
    expect(await handshakeRefusal(ws(lan, '/terminal/explain-a'), { token: TOKEN })).toMatchObject({
      status: 403,
    });
    expect(asked).toHaveLength(3);
  });

  it('refuses a remote request whose admission began while a renewal was under way and ended after it', async () => {
    const { renewToken, lan, asked, lookup } = await serveVerifyThenLookUp();
    const written = gate<void>();
    const renewal = renewToken('the-new-token', written.promise);
    const http = call(`${lan}/sessions`, { token: TOKEN });
    const upgrade = handshakeRefusal(ws(lan, '/follow/sessions'), { token: TOKEN });
    await eventually(() => expect(asked).toHaveLength(2));

    written.open();
    await renewal;
    lookup.open(true);

    expect(await http).toMatchObject(RETRY_LATER);
    expect(await upgrade).toMatchObject(RETRY_LATER);
  });

  it('refuses a local request and handshake admitted by the old token while the renewal was under way: 503 to retry; the next attempt needs the new token', async () => {
    const { renewToken, local, attachments } = await serve();
    const written = gate<void>();
    const renewal = renewToken('the-new-token', written.promise);

    expect(await call(`${local}/sessions`, { token: TOKEN })).toMatchObject(RETRY_LATER);
    expect(
      await handshakeRefusal(ws(local, '/terminal/explain-a'), { token: TOKEN }),
    ).toMatchObject(RETRY_LATER);
    written.open();
    await renewal;

    expect(attachments).toEqual([]);
    expect(
      await handshakeRefusal(ws(local, '/terminal/explain-a'), { token: TOKEN }),
    ).toMatchObject({ status: 401 });
    (await openTerminal(local, { token: 'the-new-token' })).socket.close();
  });

  it('lets a refusal overlapping it stand: told its cause, not to retry', async () => {
    const { renewToken, lan, asked, lookup } = await serveVerifyThenLookUp();
    const answer = call(`${lan}/sessions`, { token: TOKEN });
    await eventually(() => expect(asked).toHaveLength(1));

    await renewToken('the-new-token');
    lookup.open(false);

    expect(await answer).toMatchObject({ status: 403 });
  });

  it('serves later requests with the token in force when the new one could not be put in force', async () => {
    const { renewToken, local, lan } = await serve({ authorize: () => true, origins: lanOrigin });
    const follower = await openedSocket(ws(local, '/follow/sessions'), { token: TOKEN });
    const failure = new Error('EACCES: the token could not be written');

    await expect(renewToken('the-new-token', Promise.reject(failure))).rejects.toBe(failure);

    expect(await everySurface(ALL, local, { token: TOKEN })).toEqual(served(ALL));
    expect((await call(`${lan}/sessions`, {})).status).toBe(200);
    expect(follower.socket.readyState).toBe(follower.socket.OPEN);
    follower.socket.close();
  });
});

describe('closing the handler', () => {
  it('answers 503 to a request whose admission was under way when the handler closed', async () => {
    let release: (accepted: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const { handler, lan, asked } = await serve({ authorize: () => pending, origins: lanOrigin });
    const http = SURFACES['observation: GET sessions'].ask(lan, {});
    const upgrade = handshake(ws(lan, '/follow/sessions'), {});
    await eventually(() => expect(asked).toHaveLength(2));

    await handler.close();
    release(true);

    expect(await http).toEqual({ status: 503 });
    expect(await upgrade).toEqual({ status: 503 });
  });

  it('ends every request whose authorize never settles when the handler closes: 503, and the server closes', async () => {
    const { handler, lan, asked, closeServers } = await serve({
      authorize: () => new Promise<boolean>(() => {}),
      origins: lanOrigin,
    });
    const http = SURFACES['observation: GET sessions'].ask(lan, {});
    const upgrade = handshake(ws(lan, '/follow/sessions'), {});
    await eventually(() => expect(asked).toHaveLength(2));

    await handler.close();

    expect(await http).toEqual({ status: 503 });
    expect(await upgrade).toEqual({ status: 503 });
    await closeServers();
  });
});
