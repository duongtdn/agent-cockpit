import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
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
import { eventually } from '../support/eventually.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { release, writeScript } from '../support/fake-agent/script.ts';
import { startNodeHttpApp } from '../support/node-http-app.ts';
import { PATIENCE } from '../support/patience.ts';
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
  ['a node:http server', startOnNodeHttp],
  ['Fastify', startOnFastify],
])('a cockpit mounted on %s', (_server, start) => {
  it('runs a job, follows it through starting, busy and idle, and bridges its terminal to the end', async () => {
    const { cockpit, token, directory, base } = await start();
    // Held once its turn ended, until the terminal is bridged: then it exits by itself.
    writeScript(directory, [{ do: 'turn', reply: 'Explained.' }, { do: 'hold' }, { do: 'exit' }]);
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

    release(directory);

    expect(await terminal.closed).toBe(SESSION_ENDED_CLOSE_CODE);
    expect(await sessionIn(follower, 'explain-readme-md', 'ended')).toMatchObject({
      reason: 'agent-exit',
      canResume: true,
    });
    follower.socket.close();
  });

  it('renews the app’s token: every open socket, a follower’s and a terminal’s, is dropped at once (1006), the old token refused on an upgrade, the new one served', async () => {
    const { cockpit, token, directory, base } = await start();
    writeScript(directory, [{ do: 'turn', reply: 'Done.' }, { do: 'hold' }]);
    await cockpit.run('explain', { file: 'a' });
    const follower = await openedSocket(ws(base, '/follow/sessions'), { token });
    const terminal = await openedSocket(ws(base, '/terminal/explain-a'), { token });
    terminal.socket.send(JSON.stringify({ type: 'resize', columns: 80, rows: 24 }));
    await terminal.next(() => true);

    await cockpit.renewToken();

    expect(await follower.closed).toBe(1006);
    expect(await terminal.closed).toBe(1006);
    const renewed = tokenOf(cockpit);
    expect(await openSocket(ws(base, '/follow/sessions'), { token })).toMatchObject({
      refused: { status: 401 },
    });
    const again = await openedSocket(ws(base, '/terminal/explain-a'), { token: renewed });
    again.socket.close();
  });
});

describe('interrupting, ending and removing over the wire', () => {
  it('answers each through the handler: an idle session not interrupted, then ended, then removed', async () => {
    const { cockpit, token, directory, base } = await startOnNodeHttp();
    writeScript(directory, [{ do: 'turn', reply: 'Explained.' }]);
    const key = 'explain-readme-md';
    await cockpit.run('explain', { file: 'README.md' });
    await eventually(() => expect(cockpit.sessions.list()).toMatchObject([{ key, state: 'idle' }]));
    const interrupted = await post(`${base}/interrupt`, { key }, { token });
    const ended = await post(`${base}/end`, { key }, { token });
    const removed = await post(`${base}/remove`, { key }, { token });

    expect(JSON.parse(interrupted.body)).toEqual({ action: 'nothing-to-interrupt', state: 'idle' });
    expect(JSON.parse(ended.body)).toEqual({ action: 'ended', stoppedTasks: [] });
    expect(JSON.parse(removed.body)).toEqual({ action: 'removed' });
    expect(cockpit.sessions.list()).toEqual([]);
  });
});

describe('the asks over the wire', () => {
  it('answers and follows the asks through the handler, the token checked on both paths', async () => {
    const { token, base } = await startOnNodeHttp();
    const answer = { id: 'ask-1', answer: { allow: true } };

    const unanswered = await post(`${base}/asks/answer`, answer);
    const answered = await post(`${base}/asks/answer`, answer, { token });
    const refused = await openSocket(ws(base, '/follow/asks?key=explain-a'));
    const follower = await openedSocket(ws(base, '/follow/asks?key=explain-a'), { token });

    expect(unanswered.status).toBe(401);
    expect(JSON.parse(answered.body)).toMatchObject({ error: { code: 'unknown-id', id: 'ask-1' } });
    expect(refused).toMatchObject({ refused: { status: 401 } });
    expect(JSON.parse(String(await follower.next(() => true)))).toEqual({
      type: 'asks',
      pending: [],
      settled: [],
    });
    follower.socket.close();
  });
});

describe('the idle timeout', () => {
  /** Short, so that the session ends well within a condition's patience. */
  const IDLE_TIMEOUT_MS = BigInt(Math.round(PATIENCE.condition / 5));

  it("reaches the units of work from the cockpit's options: a session idle for the time the app gave ends `idle-timeout`", async () => {
    const { cockpit, directory } = await newCockpit(undefined, {
      port: APP_PORT,
      idleTimeout: `${IDLE_TIMEOUT_MS}ms`,
    });
    writeScript(directory, [{ do: 'turn', reply: 'Explained.' }]);

    await cockpit.run('explain', { file: 'README.md' });

    await eventually(() =>
      expect(cockpit.sessions.list()).toMatchObject([
        { key: 'explain-readme-md', state: 'ended', reason: 'idle-timeout' },
      ]),
    );
  });
});

describe('the request checks, through a mount', () => {
  it('serves an IPv6 loopback request with the token', async () => {
    const { cockpit, token } = await newCockpit();
    const { base } = await mount(onNodeHttp, cockpit, '::1');

    expect((await call(`${base}/sessions`, { token, headers: { host: 'localhost' } })).status).toBe(
      200,
    );
  });

  it('refuses on Fastify a request a proxy forwarded, even with the token, on HTTP and on upgrades: refused, 403', async () => {
    const { cockpit, token } = await newCockpit();
    const { base } = await mount(onFastify, cockpit);
    const options = { token, headers: { 'x-forwarded-for': '192.0.2.1' } };

    const http = await call(`${base}/sessions`, options);
    const upgrade = await openSocket(ws(base, '/follow/sessions'), options);

    for (const answer of [http, 'refused' in upgrade ? upgrade.refused : undefined]) {
      expect(answer?.status).toBe(403);
      expect(errorOf(answer?.body ?? '')).toMatchObject({ code: 'refused', cause: 'forwarded' });
    }
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
    writeScript(directory, [{ do: 'turn', reply: 'Done.' }]);
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
    writeScript(directory, [{ do: 'turn', reply: 'Done.' }]);

    await cockpit.run('explain', { file: 'a' });

    expect(deniedDomainsOf(stateDirectory, 'explain-a')).toContain(`127.0.0.1:${port}`);
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
  it('refuses a handler of an event it does not have', async () => {
    const { cockpit } = await newCockpit();

    expect(() =>
      (cockpit.on as (event: string, handler: () => void) => void)('bogus', () => {}),
    ).toThrow(TypeError);
  });
});

describe('creating and closing the cockpit', () => {
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

  it("lists each recorded key `ended` after a restart, with its record; an open or a send whose last run's job is gone is refused: unknown-job", async () => {
    made += 1;
    const directory = join(root, `work-${made}`);
    mkdirSync(directory);
    const options = {
      name: `assembly-records-${process.pid}-${made}`,
      directory,
      driver: claudeCode(),
      jobs: [explain as unknown as Job],
      stateDirectory: join(root, `state-${made}`),
      port: APP_PORT,
    };
    writeScript(directory, [{ do: 'turn', reply: 'Done.' }, { do: 'exit' }]);
    const first = await createCockpit(options);
    cleanups.push(() => createTmuxSessionHost({ appName: options.name }).shutDown());
    await first.run('explain', { file: 'a' });
    const ended = await eventually(() => {
      const [session] = first.sessions.list();
      expect(session?.state).toBe('ended');
      return session;
    });
    await first.close();

    const again = await createCockpit({ ...options, jobs: [] });
    cleanups.push(() => again.close());

    expect(again.sessions.list()).toEqual([
      {
        key: 'explain-a',
        state: 'ended',
        since: expect.any(String),
        canResume: true,
        reason: 'lost',
        record: ended?.record,
      },
    ]);
    await expect(again.open('explain-a')).rejects.toMatchObject({
      code: 'unknown-job',
      jobId: 'explain',
    });
    await expect(again.send('explain-a', 'Go on.')).rejects.toMatchObject({ code: 'unknown-job' });
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
    const othersRefused = [
      cockpit.interrupt('in-folder-a-txt'),
      cockpit.end('in-folder-a-txt'),
      cockpit.remove('in-folder-a-txt'),
    ];
    answer();

    await expect(refused).rejects.toThrow(SessionsClosedError);
    for (const other of othersRefused) await expect(other).rejects.toThrow(SessionsClosedError);
    await expect(underWay).rejects.toThrow(SessionsClosedError);
    await closing;
    expect(existsSync(join(directory, 'made-by-the-run'))).toBe(false);
  });
});
