import { EventEmitter, once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentListener,
  type AgentListenerOptions,
  type HeldHook,
  type HookHold,
  MAX_HOOK_BODY_BYTES,
  openAgentListener,
} from '../../src/server/agent-listener/agent-listener.ts';
import type { HookRequest } from '../../src/server/driver.ts';
import { UntrustedStateError } from '../../src/server/state/own-files.ts';

let folder: string;
let received: HookRequest[];
let failures: unknown[];
const opened: AgentListener[] = [];
const servers: Server[] = [];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-agent-listener-'));
  received = [];
  failures = [];
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((listener) => listener.close()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  rmSync(folder, { recursive: true, force: true });
});

async function open(
  options: Partial<Pick<AgentListenerOptions, 'agentPort' | 'receive' | 'serverTimeouts'>> = {},
): Promise<AgentListener> {
  const listener = await openAgentListener({
    folder,
    receive: (request) => received.push(request),
    reportFailure: (cause) => failures.push(cause),
    ...options,
  });
  opened.push(listener);
  return listener;
}

async function closeListener(listener: AgentListener): Promise<void> {
  opened.splice(opened.indexOf(listener), 1);
  await listener.close();
}

/** Takes a loopback port, as another program would. */
async function occupy(port = 0): Promise<number> {
  const server = createServer();
  servers.push(server);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function post(
  listener: AgentListener,
  {
    token,
    path = '/hooks',
    body = '{"hook_event_name":"Stop"}',
    method = 'POST',
  }: {
    token?: string;
    path?: string;
    body?: string;
    method?: string;
  } = {},
): Promise<Response> {
  return fetch(`${listener.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(method === 'GET' ? {} : { body }),
  });
}

/**
 * Sends a hook with the headers a test chooses, `Host` included, which
 * `fetch` sets by itself: as a browser or a page's script would send it.
 */
async function postAs(
  listener: AgentListener,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const request = httpRequest({
    host: '127.0.0.1',
    port: listener.port,
    path: '/hooks',
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    setHost: false,
  });
  request.end('{"hook_event_name":"Stop"}');
  const [response] = (await once(request, 'response')) as [IncomingMessage];
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') };
}

/** A hook the test's sessions hold, and what the listener reported of its connection. */
interface Holding {
  readonly hook: HeldHook;
  /** How many times the listener reported the connection closed. */
  closings(): number;
  /** Settles at the first report of the connection closed. */
  readonly closed: Promise<void>;
}

/**
 * A sessions' `receive` that holds every hook it takes, as the core holds
 * a permission's, and hands the held hooks to the test in their order.
 */
function holdingSessions(): {
  receive: (request: HookRequest, hold: HookHold) => void;
  next(): Promise<Holding>;
} {
  const arrived: Holding[] = [];
  const waiting: ((holding: Holding) => void)[] = [];
  return {
    receive: (_request, hold) => {
      let closings = 0;
      let reportClosed = () => {};
      const closed = new Promise<void>((resolve) => {
        reportClosed = resolve;
      });
      const hook = hold(() => {
        closings += 1;
        reportClosed();
      });
      const holding = { hook, closings: () => closings, closed };
      const taker = waiting.shift();
      if (taker === undefined) arrived.push(holding);
      else taker(holding);
    },
    next: () => {
      const holding = arrived.shift();
      if (holding !== undefined) return Promise.resolve(holding);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

/** A hook request as the agent writes it on its connection. */
function rawHook(listener: AgentListener, token: string, body = '{"hook_event_name":"Stop"}') {
  return [
    'POST /hooks HTTP/1.1',
    `Host: 127.0.0.1:${listener.port}`,
    `Authorization: Bearer ${token}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
}

/** Opens a connection to the listener, as the agent's hook does. */
async function connectTo(listener: AgentListener): Promise<Socket> {
  const socket = connect(listener.port, '127.0.0.1');
  await once(socket, 'connect');
  return socket;
}

/** What the listener wrote on a connection: its responses, which it sends chunked. */
function recordResponses(socket: Socket): {
  text(): string;
  /** Settles once the connection carried this many responses whole. */
  ended(count: number): Promise<void>;
} {
  let text = '';
  let closed = false;
  const changed = new EventEmitter();
  socket.on('data', (chunk: Buffer) => {
    text += String(chunk);
    changed.emit('change');
  });
  socket.on('close', () => {
    closed = true;
    changed.emit('change');
  });
  const endings = () => text.split('\r\n0\r\n\r\n').length - 1;
  return {
    text: () => text,
    ended: async (count) => {
      while (endings() < count) {
        if (closed) throw new Error(`The connection closed after: ${JSON.stringify(text)}`);
        await once(changed, 'change');
      }
    },
  };
}

describe('the agent-facing listener', () => {
  describe('its address', () => {
    it('listens on 127.0.0.1, and on no other loopback address', async () => {
      const listener = await open();
      expect(listener.url).toBe(`http://127.0.0.1:${listener.port}`);
      const socket = connect(listener.port, '127.0.0.2');
      const [error] = (await once(socket, 'error')) as [NodeJS.ErrnoException];
      expect(error.code).toBe('ECONNREFUSED');
    });

    it('binds the port it remembers, start after start', async () => {
      const first = await open();
      await closeListener(first);
      const second = await open();
      expect(second.port).toBe(first.port);
      expect(second.previousPort).toBeUndefined();
    });

    it('remembers the port in the state folder, for the app’s user alone', async () => {
      const listener = await open();
      const file = join(folder, 'agent-port');
      expect(readFileSync(file, 'utf8')).toBe(String(listener.port));
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('binds another port when another program took the remembered one, and remembers it', async () => {
      const first = await open();
      await closeListener(first);
      await occupy(first.port);
      const second = await open();
      expect(second.port).not.toBe(first.port);
      expect(second.previousPort).toBe(first.port);
      await closeListener(second);
      const third = await open();
      expect(third.port).toBe(second.port);
    });

    it('ignores a remembered port it cannot read', async () => {
      writeFileSync(join(folder, 'agent-port'), 'not a port', { mode: 0o600 });
      const listener = await open();
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.previousPort).toBeUndefined();
      expect(readFileSync(join(folder, 'agent-port'), 'utf8')).toBe(String(listener.port));
    });

    it('binds the port the app fixes, and remembers it', async () => {
      const port = await freePort();
      const listener = await open({ agentPort: port });
      expect(listener.port).toBe(port);
      expect(readFileSync(join(folder, 'agent-port'), 'utf8')).toBe(String(port));
    });

    it('says the remembered port is left when the app fixes another', async () => {
      const first = await open();
      await closeListener(first);
      const port = await freePort();
      const second = await open({ agentPort: port });
      expect(second.previousPort).toBe(first.port);
    });

    it('fails when the port the app fixes is taken', async () => {
      const port = await occupy();
      await expect(open({ agentPort: port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    });

    it('fails when its port cannot be remembered', async () => {
      chmodSync(folder, 0o500);
      try {
        await expect(open()).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        chmodSync(folder, 0o700);
      }
    });

    it('refuses a remembered port that is no regular file', async () => {
      mkdirSync(join(folder, 'agent-port'));
      await expect(open()).rejects.toThrow(UntrustedStateError);
    });

    it('refuses a remembered port that is a symbolic link', async () => {
      const elsewhere = join(folder, 'elsewhere');
      writeFileSync(elsewhere, String(await freePort()), { mode: 0o600 });
      symlinkSync(elsewhere, join(folder, 'agent-port'));
      await expect(open()).rejects.toThrow(UntrustedStateError);
    });

    it('narrows the remembered port’s file when others could reach it, binding that port', async () => {
      const first = await open();
      await closeListener(first);
      const file = join(folder, 'agent-port');
      chmodSync(file, 0o666);
      const second = await open();
      expect(second.port).toBe(first.port);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('frees its port when closed', async () => {
      const listener = await open();
      await post(listener, { token: listener.hooks.grant('a').token });
      await closeListener(listener);
      expect(await occupy(listener.port)).toBe(listener.port);
    });
  });

  describe('its hooks', () => {
    it('hands each session the listener’s address', async () => {
      const listener = await open();
      expect(listener.hooks.grant('a').url).toBe(listener.url);
    });

    it('passes a hook to the sessions with the key of the token it carries', async () => {
      const listener = await open();
      listener.hooks.grant('a');
      const { token } = listener.hooks.grant('b');
      const response = await post(listener, { token, body: '{"hook_event_name":"Stop","n":1}' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
      expect(received).toEqual([
        { key: 'b', path: '/hooks', body: { hook_event_name: 'Stop', n: 1 } },
      ]);
    });

    it.each([
      ['no token', undefined],
      ['a wrong token', 'x'.repeat(43)],
    ])('refuses a hook with %s', async (_, token) => {
      const listener = await open();
      listener.hooks.grant('a');
      const response = await post(listener, token === undefined ? {} : { token });
      expect(response.status).toBe(401);
      expect(received).toEqual([]);
    });

    it('refuses a token that is not sent as a bearer token', async () => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');
      const response = await fetch(`${listener.url}/hooks`, {
        method: 'POST',
        headers: { authorization: `Basic ${token}` },
        body: '{}',
      });
      expect(response.status).toBe(401);
    });

    it('refuses a revoked token', async () => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');
      listener.hooks.revoke('a');
      expect((await post(listener, { token })).status).toBe(401);
      expect(received).toEqual([]);
    });

    it('refuses an earlier launch’s token once the session is granted a new one', async () => {
      const listener = await open();
      const earlier = listener.hooks.grant('a');
      const later = listener.hooks.grant('a');
      expect((await post(listener, { token: earlier.token })).status).toBe(401);
      expect((await post(listener, { token: later.token })).status).toBe(200);
    });

    it('says nothing of its routes without a token', async () => {
      const listener = await open();
      expect((await post(listener, { path: '/elsewhere' })).status).toBe(401);
      expect((await post(listener, { method: 'GET' })).status).toBe(401);
    });

    it('serves only POST /hooks', async () => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');
      expect((await post(listener, { token, path: '/elsewhere' })).status).toBe(404);
      const get = await post(listener, { token, method: 'GET' });
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      expect(received).toEqual([]);
    });

    it('takes /hooks whatever its query', async () => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');
      expect((await post(listener, { token, path: '/hooks?x=1' })).status).toBe(200);
      expect(received[0]?.path).toBe('/hooks');
    });

    it('refuses a body that is not JSON', async () => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');
      expect((await post(listener, { token, body: '{not json' })).status).toBe(400);
      expect(received).toEqual([]);
    });

    it('refuses a body beyond its limit', async () => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');
      const body = JSON.stringify({ text: 'x'.repeat(MAX_HOOK_BODY_BYTES) });
      expect((await post(listener, { token, body })).status).toBe(413);
      expect(received).toEqual([]);
      expect((await post(listener, { token })).status).toBe(200);
    });

    it('answers 500 when the sessions fail on a hook, reports the failure, and goes on serving', async () => {
      let fail = true;
      const broken = new Error('broken');
      const listener = await open({
        receive: (request) => {
          if (fail) throw broken;
          received.push(request);
        },
      });
      const { token } = listener.hooks.grant('a');
      expect((await post(listener, { token })).status).toBe(500);
      expect(failures).toEqual([broken]);
      fail = false;
      expect((await post(listener, { token })).status).toBe(200);
      expect(received).toHaveLength(1);
    });
  });
  describe('a hook the sessions hold', () => {
    it('gets no reply until the core gives one, which is written as the body and ends the response', async () => {
      const sessions = holdingSessions();
      const listener = await open({ receive: sessions.receive });
      const { token } = listener.hooks.grant('a');

      const answer = post(listener, { token });
      const { hook, closings } = await sessions.next();

      expect(hook.reply({ hookSpecificOutput: { decision: { behavior: 'allow' } } })).toBe(
        'written',
      );
      const response = await answer;
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      expect(hook.reply({})).toBe('closed');
      hook.release();
      expect(closings()).toBe(0);
    });

    it('is ended with the answer of nothing when released, once', async () => {
      const sessions = holdingSessions();
      const listener = await open({ receive: sessions.receive });
      const { token } = listener.hooks.grant('a');

      const answer = post(listener, { token });
      const { hook, closings } = await sessions.next();
      hook.release();

      const response = await answer;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
      hook.release();
      expect(hook.reply({ decision: 'late' })).toBe('closed');
      expect(closings()).toBe(0);
    });

    it.each([
      ['closes', (socket: Socket) => socket.destroy()],
      ['resets', (socket: Socket) => socket.resetAndDestroy()],
    ])(
      'is reported once when the agent %s its connection; a reply after it is not written, and nothing throws',
      async (_, drop) => {
        const sessions = holdingSessions();
        const listener = await open({ receive: sessions.receive });
        const { token } = listener.hooks.grant('a');
        const socket = await connectTo(listener);
        const received: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => received.push(chunk));
        socket.on('error', () => {});

        socket.write(rawHook(listener, token));
        const { hook, closings, closed } = await sessions.next();
        drop(socket);
        await closed;

        expect(hook.reply({ decision: 'late' })).toBe('closed');
        hook.release();
        expect(closings()).toBe(1);
        expect(received).toEqual([]);
        expect(failures).toEqual([]);
      },
    );

    it('outlives the server’s request, headers and keep-alive timeouts, silent until its reply', async () => {
      const sessions = holdingSessions();
      const listener = await open({
        receive: sessions.receive,
        serverTimeouts: {
          headersTimeout: 50,
          requestTimeout: 100,
          keepAliveTimeout: 100,
          connectionsCheckingInterval: 10,
        },
      });
      const { token } = listener.hooks.grant('a');
      // The held hook follows an answered one on the kept-alive connection.
      const kept = await connectTo(listener);
      const responses = recordResponses(kept);
      kept.write(rawHook(listener, token));
      (await sessions.next()).hook.release();
      await responses.ended(1);
      const answered = responses.text();
      expect(answered).toMatch(/^HTTP\/1\.1 200 /);
      kept.write(rawHook(listener, token));
      const { hook, closings } = await sessions.next();

      // Each timeout seen cutting a connection of its own, opened after the hold.
      const unfinished = await connectTo(listener);
      const cut = once(unfinished, 'data');
      unfinished.write(rawHook(listener, token).slice(0, -1));
      const idle = await connectTo(listener);
      const idleClosed = once(idle.resume(), 'close');
      idle.write(rawHook(listener, token));
      (await sessions.next()).hook.release();
      expect(String((await cut)[0])).toMatch(/^HTTP\/1\.1 408 /);
      await idleClosed;

      expect(responses.text()).toBe(answered);
      expect(hook.reply({ decision: 'late' })).toBe('written');
      await responses.ended(2);
      const reply = responses.text().slice(answered.length);
      expect(reply).toMatch(/^HTTP\/1\.1 200 /);
      expect(reply).toMatch(/\{"decision":"late"\}\r\n0\r\n\r\n$/);
      expect(closings()).toBe(0);
      kept.destroy();
    });

    it('is answered 500 when the sessions fail after holding it, and no longer held', async () => {
      const broken = new Error('broken');
      const sessions = holdingSessions();
      const listener = await open({
        receive: (request, hold) => {
          sessions.receive(request, hold);
          throw broken;
        },
      });
      const { token } = listener.hooks.grant('a');

      expect((await post(listener, { token })).status).toBe(500);
      const { hook, closings } = await sessions.next();

      expect(failures).toEqual([broken]);
      expect(hook.reply({ decision: 'late' })).toBe('closed');
      expect(closings()).toBe(0);
    });

    it('is dropped when the listener closes, reported to nobody', async () => {
      const sessions = holdingSessions();
      const listener = await open({ receive: sessions.receive });
      const { token } = listener.hooks.grant('a');

      const answers = [post(listener, { token }), post(listener, { token })].map((answer) =>
        answer.then(
          () => 'answered',
          () => 'dropped',
        ),
      );
      const held = [await sessions.next(), await sessions.next()];
      await closeListener(listener);

      expect(await Promise.all(answers)).toEqual(['dropped', 'dropped']);
      expect(held.map(({ hook }) => hook.reply({ decision: 'late' }))).toEqual([
        'closed',
        'closed',
      ]);
      expect(held.map(({ closings }) => closings())).toEqual([0, 0]);
    });
  });

  describe('a request that looks like a browser’s', () => {
    it('passes what the hooks send: Host 127.0.0.1 and its port, no Origin', async () => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');

      const answer = await postAs(listener, {
        host: `127.0.0.1:${listener.port}`,
        authorization: `Bearer ${token}`,
      });

      expect(answer.status).toBe(200);
      expect(received).toHaveLength(1);
    });

    it.each([
      ['a page’s', 'http://127.0.0.1:8765'],
      ['its own', 'self'],
      ['an opaque', 'null'],
    ])('is refused 403 with %s Origin, even with a live token', async (_, origin) => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');

      const answer = await postAs(listener, {
        host: `127.0.0.1:${listener.port}`,
        origin: origin === 'self' ? listener.url : origin,
        authorization: `Bearer ${token}`,
      });

      expect(answer).toEqual({ status: 403, body: '' });
      expect(received).toEqual([]);
    });

    it.each([
      ['another name for loopback', (port: number) => `localhost:${port}`],
      ['a rebinding DNS name', (port: number) => `attacker.example:${port}`],
      ['another port', (port: number) => `127.0.0.1:${port + 1}`],
      ['no port', () => '127.0.0.1'],
    ])('is refused 403 with a Host of %s, even with a live token', async (_, hostOf) => {
      const listener = await open();
      const { token } = listener.hooks.grant('a');

      const answer = await postAs(listener, {
        host: hostOf(listener.port),
        authorization: `Bearer ${token}`,
      });

      expect(answer).toEqual({ status: 403, body: '' });
      expect(received).toEqual([]);
    });

    it('is refused before the token is read: with no token or a wrong one, still 403, never 401', async () => {
      const listener = await open();
      listener.hooks.grant('a');
      const host = `127.0.0.1:${listener.port}`;

      expect((await postAs(listener, { host, origin: 'http://127.0.0.1:8765' })).status).toBe(403);
      expect(
        (
          await postAs(listener, {
            host: `localhost:${listener.port}`,
            authorization: `Bearer ${'x'.repeat(43)}`,
          })
        ).status,
      ).toBe(403);
    });
  });
});
