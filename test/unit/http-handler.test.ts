import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHandler, type Handler, MAX_BODY_BYTES } from '../../src/server/http/handler.ts';
import type { Attachment, TerminalSize } from '../../src/server/session-host/session-host.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import type { RunResult, Session } from '../../src/shared/session.ts';
import { SESSION_ENDED_CLOSE_CODE } from '../../src/shared/wire.ts';
import { eventually } from '../support/eventually.ts';
import {
  baseUrlOf,
  call,
  type OpenSocket,
  openedSocket,
  openSocket,
  post,
} from '../support/wire-client.ts';

const TOKEN = 'the-apps-token';
const keyRules = [{ key: 'Enter', modifiers: ['shift'] as const, send: '\x1b\r' }];
const idle: Session = { key: 'explain-a', state: 'idle', since: '2026-11-26T00:00:00.000Z' };

/** A terminal attached to a session, as the host would give it, that records what it is told. */
class FakeAttachment implements Attachment {
  readonly written: string[] = [];
  readonly sizes: TerminalSize[] = [];
  detached = false;
  #data = new Set<(data: string) => void>();
  #end = new Set<() => void>();
  onData(listener: (data: string) => void) {
    this.#data.add(listener);
    return () => void this.#data.delete(listener);
  }
  onEnd(listener: () => void) {
    this.#end.add(listener);
    return () => void this.#end.delete(listener);
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(size: TerminalSize) {
    this.sizes.push(size);
  }
  async detach() {
    this.detached = true;
  }
  draw(data: string) {
    for (const listener of this.#data) listener(data);
  }
  end() {
    for (const listener of this.#end) listener();
  }
}

let server: Server;
let handler: Handler;
let base: string;
let runs: { jobId: string; args: unknown }[];
let runOutcome: () => Promise<RunResult>;
let followers: Set<(sessions: readonly Session[]) => void>;
let attachOutcome: () => Promise<Attachment | undefined>;
let attachedSizes: TerminalSize[];
let live: boolean;
let failures: { where: string; cause: unknown }[];

beforeEach(async () => {
  runs = [];
  runOutcome = async () => ({ action: 'started', state: 'busy' });
  followers = new Set();
  attachedSizes = [];
  live = true;
  failures = [];
  attachOutcome = async () => new FakeAttachment();
  handler = createHandler({
    tokenMatches: (candidate) => candidate === TOKEN,
    run: (jobId, args) => {
      runs.push({ jobId, args });
      return runOutcome();
    },
    sessions: {
      list: () => [idle],
      follow(listener) {
        followers.add(listener);
        listener([idle]);
        return () => void followers.delete(listener);
      },
    },
    terminals: {
      attach: (_key, size) => {
        attachedSizes.push(size);
        return attachOutcome();
      },
      isLive: async () => live,
    },
    keyRules,
    origins: [],
    terminal: 'on',
    reportFailure: (where, cause) => failures.push({ where, cause }),
  });
  server = createServer((request, response) => handler.handle(request, response));
  server.on('upgrade', (request, socket, head) => handler.upgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = baseUrlOf(server.address() as AddressInfo);
});

afterEach(async () => {
  await handler.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const ws = (path: string) => `${base.replace('http', 'ws')}${path}`;

function errorOf(body: string): Record<string, unknown> {
  return (JSON.parse(body) as { error: Record<string, unknown> }).error;
}

describe('the handler’s request checks', () => {
  it('refuses a request without the token, before any route is told: no-token', async () => {
    for (const path of ['/sessions', '/run', '/nothing']) {
      const reply = await call(`${base}${path}`);

      expect(reply.status).toBe(401);
      expect(errorOf(reply.body)).toMatchObject({ name: 'CockpitError', code: 'no-token' });
    }
  });

  it('refuses a request with another token: no-token', async () => {
    expect((await call(`${base}/sessions`, { token: 'not-it' })).status).toBe(401);
  });

  it('refuses a request the checks refuse before it looks at the token: refused, with its cause', async () => {
    const reply = await call(`${base}/sessions`, {
      token: TOKEN,
      headers: { origin: 'http://evil.example' },
    });

    expect(reply.status).toBe(403);
    expect(errorOf(reply.body)).toMatchObject({ code: 'refused', cause: 'origin' });
  });

  it('refuses a handshake the same ways, answering in HTTP and ending the socket', async () => {
    const without = await openSocket(ws('/follow/sessions'));
    const forwarded = await openSocket(ws('/follow/sessions'), {
      token: TOKEN,
      headers: { 'x-forwarded-for': '192.0.2.1' },
    });

    expect(without).toMatchObject({ refused: { status: 401 } });
    expect('refused' in without && errorOf(without.refused.body)).toMatchObject({
      code: 'no-token',
    });
    expect(forwarded).toMatchObject({ refused: { status: 403 } });
    expect('refused' in forwarded && errorOf(forwarded.refused.body)).toMatchObject({
      code: 'refused',
      cause: 'forwarded',
    });
  });

  it('refuses a handshake whose token rides in a header, not in the subprotocol', async () => {
    const outcome = await openSocket(ws('/follow/sessions'), {
      headers: { 'cockpit-token': TOKEN },
    });

    expect(outcome).toMatchObject({ refused: { status: 401 } });
  });
});

describe('the handler’s routes', () => {
  it('runs a job and answers what the run did', async () => {
    const reply = await post(
      `${base}/run`,
      { jobId: 'explain', args: { file: 'a' } },
      { token: TOKEN },
    );

    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(reply.body)).toEqual({ action: 'started', state: 'busy' });
    expect(runs).toEqual([{ jobId: 'explain', args: { file: 'a' } }]);
  });

  it('answers a refused run with the error and its status', async () => {
    runOutcome = async () => {
      throw new CockpitError('wrong-state', 'Busy.', { key: 'explain-a', state: 'busy' });
    };

    const reply = await post(`${base}/run`, { jobId: 'explain', args: {} }, { token: TOKEN });

    expect(reply.status).toBe(409);
    expect(errorOf(reply.body)).toEqual({
      name: 'CockpitError',
      code: 'wrong-state',
      message: 'Busy.',
      key: 'explain-a',
      state: 'busy',
    });
  });

  it('answers a failure no code names 500, with nothing of it, and reports it to the app', async () => {
    const secret = new Error('secret detail');
    runOutcome = async () => {
      throw secret;
    };

    const reply = await post(`${base}/run`, { jobId: 'explain', args: {} }, { token: TOKEN });

    expect(reply).toMatchObject({ status: 500, body: '' });
    expect(failures).toEqual([{ where: 'handler', cause: secret }]);
  });

  it('reports no failure a code names: the browser is told', async () => {
    runOutcome = async () => {
      throw new CockpitError('unknown-job', 'No such job.', { jobId: 'explain' });
    };

    expect(
      (await post(`${base}/run`, { jobId: 'explain', args: {} }, { token: TOKEN })).status,
    ).toBe(404);
    expect(failures).toEqual([]);
  });

  it.each([
    ['no JSON', 'not json'],
    ['no object', '42'],
    ['no job id', '{"args":{}}'],
    ['a job id that is no text', '{"jobId":3,"args":{}}'],
  ])('refuses a run whose body holds %s: invalid-arguments', async (_what, body) => {
    const reply = await call(`${base}/run`, { method: 'POST', body, token: TOKEN });

    expect(reply.status).toBe(400);
    expect(errorOf(reply.body)).toMatchObject({ code: 'invalid-arguments' });
    expect(runs).toEqual([]);
  });

  it('refuses a body over the limit, 413', async () => {
    const body = JSON.stringify({ jobId: 'explain', args: 'x'.repeat(MAX_BODY_BYTES) });

    expect((await call(`${base}/run`, { method: 'POST', body, token: TOKEN })).status).toBe(413);
  });

  it('lists the sessions', async () => {
    const reply = await call(`${base}/sessions`, { token: TOKEN });

    expect(JSON.parse(reply.body)).toEqual({ sessions: [idle] });
  });

  it('answers 404 for a path it does not know, 405 for another method, 426 for a socket’s path', async () => {
    expect((await call(`${base}/nothing`, { token: TOKEN })).status).toBe(404);
    const wrong = await call(`${base}/run`, { token: TOKEN });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('POST');
    const plain = await call(`${base}/follow/sessions`, { token: TOKEN });
    expect(plain.status).toBe(426);
  });

  it('answers a GET on a terminal’s path, its probe, 426 once the checks pass; another method 405', async () => {
    const probe = await call(`${base}/terminal/explain-a`, { token: TOKEN });
    expect(probe.status).toBe(426);
    expect(probe.headers.upgrade).toBe('websocket');
    expect((await call(`${base}/terminal/explain-a`)).status).toBe(401);
    const posted = await call(`${base}/terminal/explain-a`, {
      method: 'POST',
      body: '',
      token: TOKEN,
    });
    expect(posted.status).toBe(405);
    expect(posted.headers.allow).toBe('GET');
  });

  it('refuses an upgrade to a path it does not know, 404, and ends the socket', async () => {
    expect(await openSocket(ws('/sessions'), { token: TOKEN })).toMatchObject({
      refused: { status: 404 },
    });
  });

  it('selects the wire’s subprotocol, never the token’s', async () => {
    const { socket } = await openedSocket(ws('/follow/sessions'), { token: TOKEN });

    expect(socket.protocol).toBe('agent-cockpit');
    socket.close();
  });
});

describe('following the sessions', () => {
  it('sends the list at once, then at every change, until the socket closes', async () => {
    const opened = await openedSocket(ws('/follow/sessions'), { token: TOKEN });
    expect(JSON.parse(String(await opened.next(() => true)))).toEqual({
      type: 'sessions',
      sessions: [idle],
    });

    const busy: Session = { ...idle, state: 'busy' };
    for (const follower of followers) follower([busy]);

    expect(JSON.parse(String(await opened.next((m) => String(m).includes('busy'))))).toEqual({
      type: 'sessions',
      sessions: [busy],
    });
    opened.socket.close();
    await eventually(() => expect(followers.size).toBe(0));
  });
});

describe('the pty bridge', () => {
  async function openTerminal(key = 'explain-a'): Promise<OpenSocket> {
    return await openedSocket(ws(`/terminal/${key}`), { token: TOKEN });
  }

  function resize(terminal: OpenSocket, columns: number, rows: number): void {
    terminal.socket.send(JSON.stringify({ type: 'resize', columns, rows }));
  }

  it('attaches at the size the terminal sends first, sends the key rules, then the session’s output', async () => {
    const attachment = new FakeAttachment();
    attachOutcome = async () => attachment;
    const terminal = await openTerminal();

    resize(terminal, 100, 30);
    expect(JSON.parse(String(await terminal.next(() => true)))).toEqual({
      type: 'keys',
      rules: keyRules,
    });
    attachment.draw('héllo');

    expect(attachedSizes).toEqual([{ columns: 100, rows: 30 }]);
    expect(await terminal.next(Buffer.isBuffer)).toEqual(Buffer.from('héllo'));
    terminal.socket.close();
  });

  it('passes the person’s keys in and each later size, and ignores what it does not know', async () => {
    const attachment = new FakeAttachment();
    attachOutcome = async () => attachment;
    const terminal = await openTerminal();
    resize(terminal, 80, 24);
    await terminal.next(() => true);

    terminal.socket.send(Buffer.from('ls ✓\r'));
    resize(terminal, 120, 40);
    resize(terminal, 0, 40);
    resize(terminal, 1001, 40);
    terminal.socket.send('{"type":"other"}');
    terminal.socket.send('no json');

    await eventually(() => expect(attachment.written).toEqual(['ls ✓\r']));
    await eventually(() => expect(attachment.sizes).toEqual([{ columns: 120, rows: 40 }]));
    terminal.socket.close();
  });

  it('passes keys typed while the session attaches once it has', async () => {
    const attachment = new FakeAttachment();
    let release: () => void = () => {};
    attachOutcome = () =>
      new Promise((resolve) => {
        release = () => resolve(attachment);
      });
    const terminal = await openTerminal();
    resize(terminal, 80, 24);
    terminal.socket.send(Buffer.from('early'));
    await eventually(() => expect(attachedSizes).toHaveLength(1));

    release();

    await eventually(() => expect(attachment.written).toEqual(['early']));
    terminal.socket.close();
  });

  it('closes with 4000 when no session of the key lives', async () => {
    attachOutcome = async () => undefined;
    const terminal = await openTerminal();

    resize(terminal, 80, 24);

    expect(await terminal.closed).toBe(SESSION_ENDED_CLOSE_CODE);
  });

  it('closes with 1008 when the first message is not the terminal’s size', async () => {
    const terminal = await openTerminal();

    terminal.socket.send(Buffer.from('keys first'));

    expect(await terminal.closed).toBe(1008);
    expect(attachedSizes).toEqual([]);
  });

  it('closes with 1011 when the session cannot be attached, so that the terminal tries again', async () => {
    attachOutcome = async () => {
      throw new Error('tmux failed');
    };
    const terminal = await openTerminal();

    resize(terminal, 80, 24);

    expect(await terminal.closed).toBe(1011);
  });

  it('closes with 4000 when the session ends, and 1011 when only the terminal was lost', async () => {
    const ended = new FakeAttachment();
    attachOutcome = async () => ended;
    const first = await openTerminal();
    resize(first, 80, 24);
    await first.next(() => true);
    live = false;
    ended.end();
    expect(await first.closed).toBe(SESSION_ENDED_CLOSE_CODE);

    const lost = new FakeAttachment();
    attachOutcome = async () => lost;
    const second = await openTerminal();
    resize(second, 80, 24);
    await second.next(() => true);
    live = true;
    lost.end();
    expect(await second.closed).toBe(1011);
  });

  it('detaches the terminal when the socket closes; the session goes on', async () => {
    const attachment = new FakeAttachment();
    attachOutcome = async () => attachment;
    const terminal = await openTerminal();
    resize(terminal, 80, 24);
    await terminal.next(() => true);

    terminal.socket.close();

    await eventually(() => expect(attachment.detached).toBe(true));
  });

  it('detaches a terminal whose socket closed while it attached', async () => {
    const attachment = new FakeAttachment();
    let release: () => void = () => {};
    attachOutcome = () =>
      new Promise((resolve) => {
        release = () => resolve(attachment);
      });
    const terminal = await openTerminal();
    resize(terminal, 80, 24);
    await eventually(() => expect(attachedSizes).toHaveLength(1));

    terminal.socket.close();
    await terminal.closed;
    release();

    await eventually(() => expect(attachment.detached).toBe(true));
  });
});

describe('closing the handler', () => {
  it('ends every socket, detaches every terminal, and refuses what comes after', async () => {
    const attachment = new FakeAttachment();
    attachOutcome = async () => attachment;
    const terminal = await openedSocket(ws('/terminal/explain-a'), { token: TOKEN });
    terminal.socket.send(JSON.stringify({ type: 'resize', columns: 80, rows: 24 }));
    await terminal.next(() => true);
    const follower = await openedSocket(ws('/follow/sessions'), { token: TOKEN });

    await handler.close();

    expect(attachment.detached).toBe(true);
    expect(await terminal.closed).not.toBe(SESSION_ENDED_CLOSE_CODE);
    await follower.closed;
    expect((await call(`${base}/sessions`, { token: TOKEN })).status).toBe(503);
    expect(await openSocket(ws('/follow/sessions'), { token: TOKEN })).toMatchObject({
      refused: { status: 503 },
    });
  });
});
