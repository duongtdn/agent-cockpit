import { once } from 'node:events';
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
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentListener,
  MAX_HOOK_BODY_BYTES,
  openAgentListener,
} from '../../src/server/agent-listener/agent-listener.ts';
import type { HookRequest } from '../../src/server/driver.ts';
import { UntrustedStateError } from '../../src/server/state/own-files.ts';

let folder: string;
let received: HookRequest[];
const opened: AgentListener[] = [];
const servers: Server[] = [];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-agent-listener-'));
  received = [];
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((listener) => listener.close()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  rmSync(folder, { recursive: true, force: true });
});

async function open(
  options: { agentPort?: number; receive?: (request: HookRequest) => void } = {},
): Promise<AgentListener> {
  const listener = await openAgentListener({
    folder,
    receive: (request) => received.push(request),
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

    it('answers 500 when the sessions fail on a hook, and goes on serving', async () => {
      let fail = true;
      const listener = await open({
        receive: (request) => {
          if (fail) throw new Error('broken');
          received.push(request);
        },
      });
      const { token } = listener.hooks.grant('a');
      expect((await post(listener, { token })).status).toBe(500);
      fail = false;
      expect((await post(listener, { token })).status).toBe(200);
      expect(received).toHaveLength(1);
    });
  });
});
