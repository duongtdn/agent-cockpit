import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { cockpitFastify } from '../../src/fastify/index.ts';
import {
  type Cockpit,
  type CockpitOptions,
  createCockpit,
  type Job,
} from '../../src/server/index.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { SessionsClosedError } from '../../src/server/sessions/sessions.ts';
import type { Session } from '../../src/shared/session.ts';
import { SESSION_ENDED_CLOSE_CODE } from '../../src/shared/wire.ts';
import { writeAgentShim } from '../support/agent-shim.ts';
import { loadAfresh, openPage } from '../support/browser-page.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { type Turn, writeScript } from '../support/fake-agent/script.ts';
import { startNodeHttpApp } from '../support/node-http-app.ts';
import {
  baseUrlOf,
  call,
  type OpenSocket,
  openedSocket,
  openSocket,
  post,
} from '../support/wire-client.ts';

const MOUNT = '/cockpit';

const explain = {
  id: 'explain',
  title: 'Explain a file',
  args: z.object({ file: z.string().min(1) }),
  key: ({ file }: { file: string }) => `explain-${file.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  prompt: ({ file }: { file: string }) => `Explain ${file}`,
} satisfies Job<z.ZodObject<{ file: z.ZodString }>>;

/** A server the app mounted the cockpit on, listening on one address. */
interface Mounted {
  /** The mount's base URL, `http://<address>:<port>/cockpit`. */
  readonly base: string;
  close(): Promise<void>;
}

type Mount = (cockpit: Cockpit, address: string) => Promise<Mounted>;

/** A plain `node:http` server that serves the cockpit under its prefix, as the guide shows. */
const onNodeHttp: Mount = async (cockpit, address) => {
  const app = await startNodeHttpApp(address, MOUNT);
  app.serve(cockpit);
  return app;
};

/** A Fastify app with routes of its own, the cockpit registered under its prefix. */
const onFastify: Mount = async (cockpit, address) => {
  const app = Fastify();
  app.post('/echo', async (request) => ({ echoed: request.body }));
  await app.register(cockpitFastify(cockpit), { prefix: MOUNT });
  await app.listen({ port: 0, host: address });
  return {
    base: `${baseUrlOf(app.server.address() as AddressInfo)}${MOUNT}`,
    close: () => app.close(),
  };
};

/** An address of this machine beyond the loopback, where a request comes from the network. */
function networkAddress(): string {
  const found = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal);
  if (found === undefined) throw new Error('The test needs an IPv4 address beyond the loopback.');
  return found.address;
}

let root: string;
let made = 0;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-assembly-')));
  const shims = join(root, 'bin');
  mkdirSync(shims);
  writeAgentShim(shims, fakeAgentCommand());
  // The driver launches `claude` from the server's PATH, and reads the
  // conversations where the agents it launched keep them.
  vi.stubEnv('PATH', `${shims}:${process.env.PATH}`);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A cockpit of an app of its own, in folders of its own; ended, with its tmux server, after the test. */
async function newCockpit(
  jobs: readonly Job[] = [explain as unknown as Job],
  options: Partial<CockpitOptions> = {},
): Promise<{ cockpit: Cockpit; token: string; directory: string; stateDirectory: string }> {
  made += 1;
  const name = `assembly-${process.pid}-${made}`;
  const directory = join(root, `work-${made}`);
  mkdirSync(directory);
  const stateDirectory = join(root, `state-${made}`);
  const cockpit = await createCockpit({
    name,
    directory,
    driver: claudeCode(),
    jobs,
    stateDirectory,
    ...options,
  });
  cleanups.push(async () => {
    await cockpit.close();
    await createTmuxSessionHost({ appName: name }).shutDown();
  });
  return { cockpit, token: tokenOf(cockpit), directory, stateDirectory };
}

/** The token the cockpit's link carries now. */
function tokenOf(cockpit: Cockpit): string {
  return new URL(cockpit.link('http://127.0.0.1:8765/')).hash.replace('#cockpit=', '');
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function mount(on: Mount, cockpit: Cockpit, address = '127.0.0.1'): Promise<Mounted> {
  const mounted = await on(cockpit, address);
  cleanups.push(() => mounted.close());
  return mounted;
}

const ws = (base: string, path: string) => `${base.replace(/^http/, 'ws')}${path}`;

/** A promise a test settles when it chooses: an `authorize`'s lookup. */
function gate<T>(): { readonly promise: Promise<T>; open(value: T): void } {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The page's `fetch` as it reaches the app through a proxy in front of it,
 * which says whom it forwards: every request of the page is remote.
 */
function behindAProxy(pageFetch: typeof fetch): typeof fetch {
  return (input, init) =>
    pageFetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-for': '192.0.2.1' },
    });
}

function errorOf(body: string): Record<string, unknown> {
  return (JSON.parse(body) as { error: Record<string, unknown> }).error;
}

/** The states the follow socket delivered for a key, each once, in order. */
function statesOf(follower: OpenSocket, key: string): string[] {
  const states: string[] = [];
  for (const message of follower.messages) {
    const { sessions } = JSON.parse(String(message)) as { sessions: Session[] };
    const state = sessions.find((session) => session.key === key)?.state;
    if (state !== undefined && states.at(-1) !== state) states.push(state);
  }
  return states;
}

function sessionIn(follower: OpenSocket, key: string, state: string): Promise<Session> {
  return follower
    .next((message) =>
      (JSON.parse(String(message)) as { sessions: Session[] }).sessions.some(
        (session) => session.key === key && session.state === state,
      ),
    )
    .then(
      (message) =>
        (JSON.parse(String(message)) as { sessions: Session[] }).sessions.find(
          (session) => session.key === key,
        ) as Session,
    );
}

/** An app's cockpit, mounted on the loopback as the app mounts it on a server of one kind. */
interface Started {
  readonly cockpit: Cockpit;
  readonly token: string;
  readonly directory: string;
  readonly stateDirectory: string;
  readonly base: string;
  /** The port the app's server listens on. */
  readonly port: number;
}

type Start = (jobs?: readonly Job[], options?: Partial<CockpitOptions>) => Promise<Started>;

/** On a `node:http` server the app listens first, then gives the cockpit its port. */
const startOnNodeHttp: Start = async (jobs, options) => {
  const app = await startNodeHttpApp('127.0.0.1', MOUNT);
  cleanups.push(() => app.close());
  const made = await newCockpit(jobs, { port: app.port, ...options });
  app.serve(made.cockpit);
  return { ...made, base: app.base, port: app.port };
};

/** On Fastify the app gives no port: the adapter reads it from the listening server. */
const startOnFastify: Start = async (jobs, options) => {
  const made = await newCockpit(jobs, options);
  const { base } = await mount(onFastify, made.cockpit);
  return { ...made, base, port: Number(new URL(base).port) };
};

/** The domains a session's settings deny its sandboxed commands. */
function deniedDomainsOf(stateDirectory: string, key: string): string[] {
  const settings = JSON.parse(
    readFileSync(join(stateDirectory, 'sessions', key, 'settings.json'), 'utf8'),
  ) as { sandbox: { network: { deniedDomains: string[] } } };
  return settings.sandbox.network.deniedDomains;
}

/**
 * The port an app that runs its jobs in-process gives: the one its
 * browser-facing server would listen on.
 */
const APP_PORT = 4310;

describe.each([
  ['a node:http server', onNodeHttp, startOnNodeHttp],
  ['Fastify', onFastify, startOnFastify],
])('a cockpit mounted on %s', (_server, on, start) => {
  it('runs a job, follows it through starting, busy and idle, and bridges its terminal to the end', async () => {
    const { cockpit, token, directory, base } = await start();
    const script: Turn[] = [[{ do: 'reply', text: 'Explained.' }], [{ do: 'exit' }]];
    writeScript(directory, script);
    const follower = await openedSocket(ws(base, '/follow/sessions'), { token });
    expect(JSON.parse(String(await follower.next(() => true)))).toEqual({
      type: 'sessions',
      sessions: [],
    });

    const run = await post(
      `${base}/run`,
      { jobId: 'explain', args: { file: 'README.md' } },
      { token },
    );

    expect(run.status).toBe(200);
    expect(JSON.parse(run.body)).toEqual({ action: 'started', state: 'busy' });
    expect(await sessionIn(follower, 'explain-readme-md', 'idle')).toMatchObject({
      lastMessage: 'Explained.',
    });
    expect(statesOf(follower, 'explain-readme-md')).toEqual(['starting', 'busy', 'idle']);
    const listed = await call(`${base}/sessions`, { token });
    expect(JSON.parse(listed.body).sessions).toEqual(cockpit.sessions.list());

    const terminal = await openedSocket(ws(base, '/terminal/explain-readme-md'), { token });
    terminal.socket.send(JSON.stringify({ type: 'resize', columns: 100, rows: 30 }));
    expect(JSON.parse(String(await terminal.next(() => true)))).toMatchObject({ type: 'keys' });
    await terminal.next(() => output(terminal).includes('prompt: "Explain README.md"'));

    terminal.socket.send(Buffer.from('bye'));
    await terminal.next(() => output(terminal).includes('bye'));
    terminal.socket.send(Buffer.from('\r'));

    expect(await terminal.closed).toBe(SESSION_ENDED_CLOSE_CODE);
    expect(await sessionIn(follower, 'explain-readme-md', 'ended')).toMatchObject({
      reason: 'agent-exit',
      canResume: true,
    });
    follower.socket.close();
  });

  it('answers a run’s refusals with their errors', async () => {
    const { token, base } = await start();

    const unknown = await post(`${base}/run`, { jobId: 'nothing', args: {} }, { token });
    const invalid = await post(`${base}/run`, { jobId: 'explain', args: { file: '' } }, { token });

    expect(unknown.status).toBe(404);
    expect(errorOf(unknown.body)).toMatchObject({ code: 'unknown-job', jobId: 'nothing' });
    expect(invalid.status).toBe(400);
    expect(errorOf(invalid.body)).toMatchObject({
      code: 'invalid-arguments',
      issues: [{ path: ['file'] }],
    });
  });

  it('closes a terminal of a key with no session with 4000, and answers 404 under the mount', async () => {
    const { token, base } = await start();

    const terminal = await openedSocket(ws(base, '/terminal/nothing'), { token });
    terminal.socket.send(JSON.stringify({ type: 'resize', columns: 80, rows: 24 }));

    expect(await terminal.closed).toBe(SESSION_ENDED_CLOSE_CODE);
    expect((await call(`${base}/nothing`, { token })).status).toBe(404);
    expect(await openSocket(ws(base, '/nothing'), { token })).toMatchObject({
      refused: { status: 404 },
    });
  });

  it("keeps every session's sandbox from the app's port", async () => {
    const { cockpit, directory, stateDirectory, port } = await start();
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);

    await cockpit.run('explain', { file: 'a' });

    expect(deniedDomainsOf(stateDirectory, 'explain-a')).toEqual(
      expect.arrayContaining([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]),
    );
  });

  it('renews the app’s token: the old one refused at once, every socket closed, the new link served', async () => {
    const { cockpit, token, directory, stateDirectory, base } = await start();
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);
    await cockpit.run('explain', { file: 'a' });
    const follower = await openedSocket(ws(base, '/follow/sessions'), { token });
    const terminal = await openedSocket(ws(base, '/terminal/explain-a'), { token });
    terminal.socket.send(JSON.stringify({ type: 'resize', columns: 80, rows: 24 }));
    await terminal.next(() => true);

    await cockpit.renewToken();

    expect(await follower.closed).toBe(1006);
    expect(await terminal.closed).toBe(1006);
    const renewed = tokenOf(cockpit);
    expect(renewed).not.toBe(token);
    expect(readFileSync(join(stateDirectory, 'app-token'), 'utf8')).toBe(renewed);
    expect(statSync(join(stateDirectory, 'app-token')).mode & 0o777).toBe(0o600);
    const old = await call(`${base}/sessions`, { token });
    expect(old.status).toBe(401);
    expect(errorOf(old.body)).toMatchObject({ code: 'no-token' });
    expect(await openSocket(ws(base, '/follow/sessions'), { token })).toMatchObject({
      refused: { status: 401 },
    });
    expect((await call(`${base}/sessions`, { token: renewed })).status).toBe(200);
    const again = await openedSocket(ws(base, '/terminal/explain-a'), { token: renewed });
    again.socket.close();
  });

  describe('opened by the app, through the mount', () => {
    const forwarded = { 'x-forwarded-for': '192.0.2.1' };

    it('serves a remote request authorize accepts, without the token, on HTTP and upgrades; refuses one it does not', async () => {
      const { base } = await start(undefined, {
        authorize: (request) => request.headers['x-app-password'] === 'open',
      });
      const accepted = { ...forwarded, 'x-app-password': 'open' };

      expect((await call(`${base}/sessions`, { headers: accepted })).status).toBe(200);
      (await openedSocket(ws(base, '/follow/sessions'), { headers: accepted })).socket.close();
      const http = await call(`${base}/sessions`, { headers: forwarded });
      const upgrade = await openSocket(ws(base, '/follow/sessions'), { headers: forwarded });
      for (const answer of [http, 'refused' in upgrade ? upgrade.refused : undefined]) {
        expect(answer?.status).toBe(403);
        expect(errorOf(answer?.body ?? '')).toMatchObject({ code: 'refused', cause: 'forwarded' });
      }
    });

    it('refuses a remote request and handshake that verify passed with the token renewed while authorize looked the person up: 503 to retry; the next ones are asked afresh', async () => {
      let lookUp: (found: boolean) => void = () => {};
      const lookup = new Promise<boolean>((resolve) => {
        lookUp = resolve;
      });
      let asked = 0;
      let cockpit: Cockpit | undefined;
      const started = await start(undefined, {
        authorize: async (request) => {
          asked += 1;
          return (cockpit?.verify(request) ?? false) && (await lookup);
        },
      });
      cockpit = started.cockpit;
      const { token, base } = started;
      const http = call(`${base}/sessions`, { token, headers: forwarded });
      const upgrade = openSocket(ws(base, '/follow/sessions'), { token, headers: forwarded });
      await vi.waitFor(() => expect(asked).toBe(2));

      await cockpit.renewToken();
      lookUp(true);

      const retryLater = {
        status: 503,
        headers: expect.objectContaining({ 'retry-after': '1' }),
        body: JSON.stringify({ retry: true }),
      };
      expect(await http).toMatchObject(retryLater);
      expect(await upgrade).toMatchObject({ refused: retryLater });
      expect(asked).toBe(2);
      const renewed = tokenOf(cockpit);
      expect((await call(`${base}/sessions`, { token: renewed, headers: forwarded })).status).toBe(
        200,
      );
      (
        await openedSocket(ws(base, '/follow/sessions'), { token: renewed, headers: forwarded })
      ).socket.close();
      expect((await call(`${base}/sessions`, { token, headers: forwarded })).status).toBe(403);
      expect(asked).toBe(5);
    });

    it("makes the browser client's run again once a renewal overlapped it, with the token the page holds then, and resolves with what it did", async () => {
      const lookup = gate<boolean>();
      let asked = 0;
      let cockpit: Cockpit | undefined;
      const started = await start(undefined, {
        authorize: async (request) => {
          asked += 1;
          return (cockpit?.verify(request) ?? false) && (await lookup.promise);
        },
      });
      cockpit = started.cockpit;
      writeScript(started.directory, [[{ do: 'reply', text: 'Done.' }]]);
      const page = openPage(`http://127.0.0.1:8765/#cockpit=${started.token}`);
      cleanups.push(async () => {
        vi.unstubAllGlobals();
      });
      vi.stubGlobal('fetch', behindAProxy(fetch));
      const client = (
        await loadAfresh(() => import('../../src/client/index.ts'))
      ).createCockpitClient({ baseUrl: started.base });
      const run = client.run('explain', { file: 'a' });
      await vi.waitFor(() => expect(asked).toBe(1));

      await cockpit.renewToken();
      page.followFragment(`cockpit=${tokenOf(cockpit)}`);
      lookup.open(true);

      expect(await run).toEqual({ action: 'started', state: 'busy' });
      expect(asked).toBe(2);
    });

    it('admits an origin the app allowed, and a Host naming it', async () => {
      const { token, base } = await start(undefined, { origins: ['http://app.example:8080'] });
      const headers = { origin: 'http://app.example:8080', host: 'app.example:8080' };

      expect((await call(`${base}/sessions`, { token, headers })).status).toBe(200);
      (await openedSocket(ws(base, '/follow/sessions'), { token, headers })).socket.close();
    });

    it('keeps a loopback terminal from a remote request authorize accepted, its probe too; serves a local one', async () => {
      const { token, base } = await start(undefined, {
        authorize: () => true,
        terminal: 'loopback',
      });

      const probe = await call(`${base}/terminal/nothing`, { headers: forwarded });
      const upgrade = await openSocket(ws(base, '/terminal/nothing'), { headers: forwarded });
      for (const answer of [probe, 'refused' in upgrade ? upgrade.refused : undefined]) {
        expect(answer?.status).toBe(403);
        expect(errorOf(answer?.body ?? '')).toMatchObject({
          code: 'refused',
          cause: 'terminal-off',
        });
      }
      expect((await call(`${base}/terminal/nothing`, { token })).status).toBe(426);
      (await openedSocket(ws(base, '/terminal/nothing'), { token })).socket.close();
      expect((await call(`${base}/sessions`, { headers: forwarded })).status).toBe(200);
    });

    it('refuses every terminal request when the terminal is off, a local one with the token too', async () => {
      const { token, base } = await start(undefined, { terminal: 'off' });

      const probe = await call(`${base}/terminal/nothing`, { token });
      const upgrade = await openSocket(ws(base, '/terminal/nothing'), { token });
      for (const answer of [probe, 'refused' in upgrade ? upgrade.refused : undefined]) {
        expect(answer?.status).toBe(403);
        expect(errorOf(answer?.body ?? '')).toMatchObject({
          code: 'refused',
          cause: 'terminal-off',
        });
      }
      expect((await call(`${base}/sessions`, { token })).status).toBe(200);
    });
  });

  describe('the request checks, on HTTP and on upgrades alike', () => {
    let cockpit: Cockpit;
    let token: string;
    let base: string;
    // One cockpit for every check: it outlives each test's own cleanups.
    const own: (() => Promise<void>)[] = [];

    beforeAll(async () => {
      ({ cockpit, token } = await newCockpit());
      own.push(...cleanups.splice(0));
      const mounted = await on(cockpit, '127.0.0.1');
      base = mounted.base;
      own.push(() => mounted.close());
    });

    afterAll(async () => {
      for (const cleanup of own.reverse()) await cleanup();
    });

    /** Asks the same of the HTTP route and of the WebSocket's, and gives both answers. */
    async function bothWays(
      options: { token?: string; headers?: Record<string, string>; localAddress?: string },
      where = base,
    ) {
      const http = await call(`${where}/sessions`, options);
      const upgrade = await openSocket(ws(where, '/follow/sessions'), options);
      if (!('refused' in upgrade)) throw new Error('The upgrade was not refused.');
      return [http, upgrade.refused];
    }

    it('serves a local request with the token', async () => {
      expect((await call(`${base}/sessions`, { token })).status).toBe(200);
      const follower = await openedSocket(ws(base, '/follow/sessions'), { token });
      follower.socket.close();
    });

    it.each([
      ['no token', {}],
      ['another token', { token: 'A'.repeat(43) }],
    ])('refuses a request with %s: no-token, 401', async (_what, options) => {
      for (const answer of await bothWays(options)) {
        expect(answer.status).toBe(401);
        expect(errorOf(answer.body)).toMatchObject({ code: 'no-token' });
      }
    });

    it.each([
      ['a forwarding header', { 'x-forwarded-for': '192.0.2.1' }, 'forwarded'],
      ['a Forwarded header', { forwarded: 'for=192.0.2.1' }, 'forwarded'],
      ['an X-Real-IP header', { 'x-real-ip': '192.0.2.1' }, 'forwarded'],
      ['an Origin of another site', { origin: 'http://evil.example' }, 'origin'],
      ['a Host of another name', { host: 'evil.example:80' }, 'host'],
    ])(
      'refuses a request with %s, even with the token: refused, 403',
      async (_what, headers, cause) => {
        for (const answer of await bothWays({ token, headers })) {
          expect(answer.status).toBe(403);
          expect(errorOf(answer.body)).toMatchObject({ code: 'refused', cause });
        }
      },
    );

    it('refuses a request from beyond the loopback, even with the token: remote', async () => {
      const { base: remote } = await mount(on, cockpit, networkAddress());

      for (const answer of await bothWays({ token, headers: { host: '127.0.0.1' } }, remote)) {
        expect(answer.status).toBe(403);
        expect(errorOf(answer.body)).toMatchObject({ code: 'refused', cause: 'remote' });
      }
    });

    it('refuses a loopback request to another 127.x address, even with the token: local-address', async () => {
      const { base: other } = await mount(on, cockpit, '127.0.0.2');

      for (const answer of await bothWays({ token, headers: { host: '127.0.0.1' } }, other)) {
        expect(answer.status).toBe(403);
        expect(errorOf(answer.body)).toMatchObject({ code: 'refused', cause: 'local-address' });
      }
    });

    it('serves an IPv6 loopback request with the token', async () => {
      const { base: six } = await mount(on, cockpit, '::1');

      expect(
        (await call(`${six}/sessions`, { token, headers: { host: 'localhost' } })).status,
      ).toBe(200);
    });
  });
});

describe("the app's port with the neutral handler", () => {
  it('refuses a run while the app gave none: no-app-port, 503, nothing launched', async () => {
    const { cockpit, token } = await newCockpit();
    const { base } = await mount(onNodeHttp, cockpit);

    const refused = await post(`${base}/run`, { jobId: 'explain', args: { file: 'a' } }, { token });

    expect(refused.status).toBe(503);
    expect(errorOf(refused.body)).toMatchObject({ code: 'no-app-port' });
    await expect(cockpit.run('explain', { file: 'a' })).rejects.toMatchObject({
      code: 'no-app-port',
    });
    expect(cockpit.sessions.list()).toEqual([]);
  });

  it('keeps the sessions from every port the app gave', async () => {
    const { cockpit, directory, stateDirectory } = await newCockpit(undefined, {
      port: [APP_PORT, 8443],
    });
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);

    await cockpit.run('explain', { file: 'a' });

    expect(deniedDomainsOf(stateDirectory, 'explain-a')).toEqual(
      expect.arrayContaining([`127.0.0.1:${APP_PORT}`, '127.0.0.1:8443']),
    );
  });
});

describe('the Fastify adapter', () => {
  it('learns the port once the server listens: a run before is refused, no-app-port', async () => {
    const { cockpit, directory, stateDirectory } = await newCockpit();
    const app = Fastify();
    await app.register(cockpitFastify(cockpit), { prefix: MOUNT });
    cleanups.push(() => app.close());

    await expect(cockpit.run('explain', { file: 'a' })).rejects.toMatchObject({
      code: 'no-app-port',
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);
    await cockpit.run('explain', { file: 'a' });

    expect(deniedDomainsOf(stateDirectory, 'explain-a')).toContain(`127.0.0.1:${port}`);
  });

  it('learns the port of a server that listened outside Fastify’s listen', async () => {
    const { cockpit, directory, stateDirectory } = await newCockpit();
    const app = Fastify();
    await app.register(cockpitFastify(cockpit), { prefix: MOUNT });
    await app.ready();
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => app.close());
    const { port } = app.server.address() as AddressInfo;
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);

    await cockpit.run('explain', { file: 'a' });

    expect(deniedDomainsOf(stateDirectory, 'explain-a')).toContain(`127.0.0.1:${port}`);
  });

  it('joins the ports the app gave to the one it learns', async () => {
    const { cockpit, directory, stateDirectory } = await newCockpit(undefined, { port: APP_PORT });
    const { base } = await mount(onFastify, cockpit);
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);

    await cockpit.run('explain', { file: 'a' });

    expect(deniedDomainsOf(stateDirectory, 'explain-a')).toEqual(
      expect.arrayContaining([`127.0.0.1:${APP_PORT}`, `127.0.0.1:${new URL(base).port}`]),
    );
  });

  it('forgets the server once Fastify closes', async () => {
    const { cockpit } = await newCockpit();
    const app = Fastify();
    await app.register(cockpitFastify(cockpit), { prefix: MOUNT });
    await app.listen({ port: 0, host: '127.0.0.1' });
    await app.close();

    await expect(cockpit.run('explain', { file: 'a' })).rejects.toMatchObject({
      code: 'no-app-port',
    });
  });

  it('leaves the app’s own routes, and their bodies, to the app', async () => {
    const { cockpit } = await newCockpit();
    const { base } = await mount(onFastify, cockpit);

    const echoed = await post(`${base.replace(MOUNT, '')}/echo`, { a: 1 });

    expect(JSON.parse(echoed.body)).toEqual({ echoed: { a: 1 } });
  });

  it('ends an upgrade outside its prefix when the app handles no upgrade itself, as Node would', async () => {
    const { cockpit, token } = await newCockpit();
    const { base } = await mount(onFastify, cockpit);
    const root = base.replace(MOUNT, '');

    expect(await openSocket(ws(root, '/elsewhere'), { token })).toEqual({ destroyed: true });
  });

  it('leaves upgrades outside its prefix to the app', async () => {
    const { cockpit, token } = await newCockpit();
    const app = Fastify();
    await app.register(cockpitFastify(cockpit), { prefix: MOUNT });
    const others: string[] = [];
    app.server.on('upgrade', (request, socket) => {
      others.push(request.url ?? '');
      socket.destroy();
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const root = baseUrlOf(app.server.address() as AddressInfo);

    expect(await openSocket(ws(root, '/elsewhere'), { token })).toEqual({ destroyed: true });
    expect(await openSocket(ws(root, '/cockpitx/follow/sessions'), { token })).toEqual({
      destroyed: true,
    });
    expect(others).toEqual(['/elsewhere', '/cockpitx/follow/sessions']);
  });
});

describe("the app's token on the app's own routes", () => {
  it('is verified from the header the client sends, and from nothing else', async () => {
    const { cockpit, token } = await newCockpit();
    const requests: boolean[] = [];
    const server = createServer((request, response) => {
      requests.push(cockpit.verify(request));
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const base = baseUrlOf(server.address() as AddressInfo);

    await call(`${base}/api/whoami`, { token });
    await call(`${base}/api/whoami`, { token: 'not-it' });
    await call(`${base}/api/whoami`);

    expect(requests).toEqual([true, false, false]);
  });
});

describe('a failure the browser is not told of', () => {
  it("reaches the app's error handlers, the browser answered 500 with nothing of it", async () => {
    const broken = new Error('a bug in the job');
    const failing = {
      ...explain,
      id: 'failing',
      key: () => {
        throw broken;
      },
    };
    const { cockpit, token } = await newCockpit([failing as unknown as Job]);
    const failures: unknown[] = [];
    cockpit.on('error', (error) => failures.push(error));
    const { base } = await mount(onNodeHttp, cockpit);

    const reply = await post(`${base}/run`, { jobId: 'failing', args: { file: 'a' } }, { token });

    expect(reply).toMatchObject({ status: 500, body: '' });
    expect(failures).toEqual([
      expect.objectContaining({ code: 'internal-failure', where: 'handler', cause: broken }),
    ]);
  });
});

describe("the cockpit's status of the agent", () => {
  it('takes a handler of untested versions, removed by the function it gives', async () => {
    const { cockpit } = await newCockpit();

    const stop = cockpit.on('untested-version', () => {});

    expect(stop).toBeTypeOf('function');
    expect(stop()).toBeUndefined();
  });

  it('refuses a handler of an event it does not have', async () => {
    const { cockpit } = await newCockpit();

    expect(() =>
      (cockpit.on as (event: string, handler: () => void) => void)('bogus', () => {}),
    ).toThrow(TypeError);
  });
});

describe('creating and closing the cockpit', () => {
  it('refuses options that do not fit before it writes anything', async () => {
    const stateDirectory = join(root, 'never');

    await expect(
      createCockpit({
        name: 'never',
        directory: root,
        driver: claudeCode(),
        jobs: [],
        stateDirectory,
        port: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid-options', issues: [{ path: ['port'] }] });
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it('keeps the app’s token across a restart, and lets the next process take the lock once closed', async () => {
    made += 1;
    const options = {
      name: `assembly-restart-${process.pid}`,
      directory: root,
      driver: claudeCode(),
      jobs: [],
      stateDirectory: join(root, `state-${made}`),
    };
    const first = await createCockpit(options);
    const link = first.link('http://127.0.0.1:8765/');
    await first.close();
    await first.close();

    const second = await createCockpit(options);
    cleanups.push(() => second.close());

    expect(second.link('http://127.0.0.1:8765/')).toBe(link);
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:8765\/#cockpit=[A-Za-z0-9_-]{43}$/);
  });

  it('renews no token once closed: the lock is released, the file another process’s', async () => {
    const { cockpit, stateDirectory } = await newCockpit();
    const kept = readFileSync(join(stateDirectory, 'app-token'), 'utf8');
    await cockpit.close();

    await expect(cockpit.renewToken()).rejects.toThrow('closed');
    expect(readFileSync(join(stateDirectory, 'app-token'), 'utf8')).toBe(kept);
  });

  describe('the state folder, the cockpit’s own', () => {
    function optionsIn(stateDirectory?: string) {
      made += 1;
      return {
        name: `assembly-state-${process.pid}-${made}`,
        directory: root,
        driver: claudeCode(),
        jobs: [],
        ...(stateDirectory === undefined ? {} : { stateDirectory }),
      };
    }

    it.each([
      ['*', '*'],
      ['?', '?'],
      ['[', '['],
      [']', ']'],
      ['{', '{'],
      ['}', '}'],
      ['(', '('],
      [')', ')'],
      ['\\', '\\'],
      ['a newline', '\n'],
      ['a tab', '\t'],
      ['an escape', '\u001b'],
      ['a delete', '\u007f'],
      ['a C1 control', '\u0085'],
    ])(
      'refuses a folder the app named whose path holds %s, which a deny rule reads as its own, before it writes anything',
      async (_, character) => {
        const stateDirectory = join(root, `glob-${character}-${made}`);
        await expect(createCockpit(optionsIn(stateDirectory))).rejects.toMatchObject({
          code: 'invalid-options',
          issues: [{ path: ['stateDirectory'], message: expect.stringContaining(stateDirectory) }],
        });
        expect(existsSync(stateDirectory)).toBe(false);
      },
    );

    it('refuses a folder the app named whose real path holds a pattern character, under a linked folder', async () => {
      const real = join(root, `real-[${made}]`);
      mkdirSync(real);
      const linked = join(root, `linked-plain-${made}`);
      symlinkSync(real, linked);
      await expect(createCockpit(optionsIn(join(linked, 'state')))).rejects.toMatchObject({
        code: 'invalid-options',
        issues: [
          { path: ['stateDirectory'], message: expect.stringContaining(join(real, 'state')) },
        ],
      });
      expect(existsSync(join(real, 'state'))).toBe(false);
    });

    it('refuses a default state root whose path holds a pattern character, saying it is the default', async () => {
      const before = process.env.XDG_STATE_HOME;
      const xdg = join(root, `xdg-{${made}}`);
      vi.stubEnv('XDG_STATE_HOME', xdg);
      try {
        await expect(createCockpit(optionsIn())).rejects.toMatchObject({
          code: 'invalid-options',
          issues: [{ path: [], message: expect.stringContaining(join(xdg, 'agent-cockpit')) }],
        });
        expect(existsSync(xdg)).toBe(false);
      } finally {
        vi.stubEnv('XDG_STATE_HOME', before);
      }
    });

    it('narrows a folder the app named that its group could write, and keeps it so', async () => {
      const stateDirectory = join(root, `shared-${made}`);
      mkdirSync(stateDirectory);
      chmodSync(stateDirectory, 0o775);
      const cockpit = await createCockpit(optionsIn(stateDirectory));
      cleanups.push(() => cockpit.close());
      expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(join(stateDirectory, 'app-token')).mode & 0o777).toBe(0o600);
    });

    it('refuses a folder the app named that is a symbolic link, on `stateDirectory`', async () => {
      const target = join(root, `target-${made}`);
      mkdirSync(target, { mode: 0o700 });
      const stateDirectory = join(root, `linked-${made}`);
      symlinkSync(target, stateDirectory);
      await expect(createCockpit(optionsIn(stateDirectory))).rejects.toMatchObject({
        code: 'invalid-options',
        issues: [{ path: ['stateDirectory'], message: expect.stringContaining(stateDirectory) }],
      });
    });

    it('refuses a folder the app named under a parent others can write, on `stateDirectory`', async () => {
      const parent = join(root, `shared-parent-${made}`);
      mkdirSync(parent);
      chmodSync(parent, 0o757);
      await expect(createCockpit(optionsIn(join(parent, 'state')))).rejects.toMatchObject({
        code: 'invalid-options',
        issues: [{ path: ['stateDirectory'], message: expect.stringContaining(parent) }],
      });
    });

    it('refuses a planted file in the folder the app named, naming it on `stateDirectory`', async () => {
      const stateDirectory = join(root, `planted-${made}`);
      mkdirSync(stateDirectory, { mode: 0o700 });
      const elsewhere = join(root, `planted-token-${made}`);
      writeFileSync(elsewhere, 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E', { mode: 0o600 });
      symlinkSync(elsewhere, join(stateDirectory, 'app-token'));
      await expect(createCockpit(optionsIn(stateDirectory))).rejects.toMatchObject({
        code: 'invalid-options',
        issues: [
          {
            path: ['stateDirectory'],
            message: expect.stringContaining(join(stateDirectory, 'app-token')),
          },
        ],
      });
    });

    it('refuses the default folder when it is not the cockpit’s own, saying it is the default', async () => {
      const before = process.env.XDG_STATE_HOME;
      const xdg = join(root, `xdg-${made}`);
      vi.stubEnv('XDG_STATE_HOME', xdg);
      const options = optionsIn();
      const folder = join(xdg, 'agent-cockpit', options.name);
      const target = join(root, `default-target-${made}`);
      mkdirSync(join(xdg, 'agent-cockpit'), { recursive: true });
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, folder);
      try {
        const refused = await createCockpit(options).catch((error: unknown) => error);
        expect(refused).toMatchObject({ code: 'invalid-options', issues: [{ path: [] }] });
        const [issue] = (refused as { issues: { message: string }[] }).issues;
        expect(issue?.message).toContain(`The default state folder ${folder}`);
      } finally {
        vi.stubEnv('XDG_STATE_HOME', before);
      }
    });
  });

  it('settles a run still pending when it is closed, and launches nothing more', async () => {
    const { cockpit, directory } = await newCockpit(undefined, { port: APP_PORT });
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);

    const pending = cockpit.run('explain', { file: 'a.txt' });
    await cockpit.close();

    await expect(pending).rejects.toThrow(SessionsClosedError);
    await expect(cockpit.run('explain', { file: 'b.txt' })).rejects.toThrow(SessionsClosedError);
  });

  it('refuses a run asked once its close began, and makes no folder for one under way', async () => {
    let choicesAsked = () => {};
    const asked = new Promise<void>((resolve) => {
      choicesAsked = resolve;
    });
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const inFolder = {
      ...explain,
      id: 'in-folder',
      // Answers once the close began: the run is under way, checking its choices, meanwhile.
      options: {
        file: async () => {
          choicesAsked();
          await answered;
          return [{ value: 'a.txt' }];
        },
      },
      directory: () => 'made-by-the-run',
    };
    const { cockpit, directory } = await newCockpit([inFolder as unknown as Job], {
      port: APP_PORT,
    });
    const underWay = cockpit.run('in-folder', { file: 'a.txt' });
    underWay.catch(() => {});
    await asked;

    const closing = cockpit.close();
    const refused = cockpit.run('in-folder', { file: 'a.txt' });
    answer();

    await expect(refused).rejects.toThrow(SessionsClosedError);
    await expect(underWay).rejects.toThrow(SessionsClosedError);
    await closing;
    expect(existsSync(join(directory, 'made-by-the-run'))).toBe(false);
  });

  it('runs a job in-process, as the browser does', async () => {
    const { cockpit, directory } = await newCockpit(undefined, { port: APP_PORT });
    // At work until the test ends: the second run finds it `busy`, however soon a turn could end.
    writeScript(directory, [[{ do: 'stay-busy' }]]);
    const seen: string[] = [];
    const stop = cockpit.sessions.follow((sessions) => {
      const state = sessions[0]?.state;
      if (state !== undefined && seen.at(-1) !== state) seen.push(state);
    });

    expect(await cockpit.run('explain', { file: 'a.txt' })).toEqual({
      action: 'started',
      state: 'busy',
    });
    await expect(cockpit.run('explain', { file: 'a.txt' })).rejects.toMatchObject({
      code: 'wrong-state',
      key: 'explain-a-txt',
    });
    await expect(cockpit.run('nothing', {})).rejects.toMatchObject({ code: 'unknown-job' });
    stop();
    expect(seen).toEqual(['starting', 'busy']);
  });
});

/** Everything the terminal received as output so far, as text. */
function output(terminal: OpenSocket): string {
  return Buffer.concat(terminal.messages.filter(Buffer.isBuffer)).toString('utf8');
}
