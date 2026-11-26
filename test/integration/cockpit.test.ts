import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { cockpitFastify } from '../../src/fastify/index.ts';
import { type Cockpit, createCockpit, type Job } from '../../src/server/index.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { SessionsClosedError } from '../../src/server/sessions/sessions.ts';
import type { Session } from '../../src/shared/session.ts';
import { SESSION_ENDED_CLOSE_CODE } from '../../src/shared/wire.ts';
import { writeAgentShim } from '../support/agent-shim.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { type Turn, writeScript } from '../support/fake-agent/script.ts';
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
  const under = (url: string | undefined) =>
    url === MOUNT || url?.startsWith(`${MOUNT}/`) || url?.startsWith(`${MOUNT}?`);
  const server: Server = createServer((request, response) => {
    if (!under(request.url)) return void response.writeHead(404).end('the app’s own');
    request.url = request.url?.slice(MOUNT.length) || '/';
    cockpit.handle(request, response);
  });
  server.on('upgrade', (request, socket, head) => {
    if (!under(request.url)) return void socket.destroy();
    request.url = request.url?.slice(MOUNT.length) || '/';
    cockpit.upgrade(request, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, address, resolve));
  return {
    base: `${baseUrlOf(server.address() as AddressInfo)}${MOUNT}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
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
async function newCockpit(): Promise<{ cockpit: Cockpit; token: string; directory: string }> {
  made += 1;
  const name = `assembly-${process.pid}-${made}`;
  const directory = join(root, `work-${made}`);
  mkdirSync(directory);
  const cockpit = await createCockpit({
    name,
    directory,
    driver: claudeCode(),
    jobs: [explain],
    stateDirectory: join(root, `state-${made}`),
  });
  cleanups.push(async () => {
    await cockpit.close();
    await createTmuxSessionHost({ appName: name }).shutDown();
  });
  const token = new URL(cockpit.link('http://127.0.0.1:8765/')).hash.replace('#cockpit=', '');
  return { cockpit, token, directory };
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

describe.each([
  ['a node:http server', onNodeHttp],
  ['Fastify', onFastify],
])('a cockpit mounted on %s', (_server, on) => {
  it('runs a job, follows it through starting, busy and idle, and bridges its terminal to the end', async () => {
    const { cockpit, token, directory } = await newCockpit();
    const { base } = await mount(on, cockpit);
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
    const { cockpit, token } = await newCockpit();
    const { base } = await mount(on, cockpit);

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
    const { cockpit, token } = await newCockpit();
    const { base } = await mount(on, cockpit);

    const terminal = await openedSocket(ws(base, '/terminal/nothing'), { token });
    terminal.socket.send(JSON.stringify({ type: 'resize', columns: 80, rows: 24 }));

    expect(await terminal.closed).toBe(SESSION_ENDED_CLOSE_CODE);
    expect((await call(`${base}/nothing`, { token })).status).toBe(404);
    expect(await openSocket(ws(base, '/nothing'), { token })).toMatchObject({
      refused: { status: 404 },
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

describe('the Fastify adapter', () => {
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
        port: 8765,
      } as never),
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
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);

    const pending = cockpit.run('explain', { file: 'a.txt' });
    await cockpit.close();

    await expect(pending).rejects.toThrow(SessionsClosedError);
    await expect(cockpit.run('explain', { file: 'b.txt' })).rejects.toThrow(SessionsClosedError);
  });

  it('runs a job in-process, as the browser does', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);
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
