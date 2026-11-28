import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHandler, type Handler, MAX_BODY_BYTES } from '../../src/server/http/handler.ts';
import type { Attachment, TerminalSize } from '../../src/server/session-host/session-host.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import type { Ask, AskSettled } from '../../src/shared/ask.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import type { JobDescription } from '../../src/shared/job.ts';
import type { EndResult, RunResult, Session } from '../../src/shared/session.ts';
import {
  ASKS_ANSWER_PATH,
  END_PATH,
  FOLLOW_ASKS_PATH,
  FOLLOW_SESSIONS_PATH,
  INTERRUPT_PATH,
  JOBS_PATH,
  OPEN_PATH,
  OPTIONS_PATH,
  REMOVE_PATH,
  RUN_PATH,
  SEND_PATH,
  SESSION_ENDED_CLOSE_CODE,
  SESSIONS_PATH,
  terminalPath,
} from '../../src/shared/wire.ts';
import { eventually } from '../support/eventually.ts';
import { FakeAttachment } from '../support/fake-attachment.ts';
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

let server: Server;
let handler: Handler;
let base: string;
let runs: { jobId: string; args: unknown; options?: unknown }[];
/** Every other operation the handler asked for, with what it was given. */
let asked: { operation: string; given: unknown[] }[];
let runOutcome: () => Promise<RunResult>;
let endOutcome: () => Promise<EndResult>;
let followers: Set<(sessions: readonly Session[]) => void>;
let attachOutcome: () => Promise<Attachment | undefined>;
let attachedSizes: TerminalSize[];
let live: boolean;
let failures: { where: string; cause: unknown }[];
let answerOutcome: () => Promise<void>;
/** The asks pending, as the follows of the asks are first given them. */
let pendingAsks: Ask[];
/** The settlements remembered, as the snapshot of the asks reads them. */
let rememberedSettled: AskSettled[];
let askFollowers: Set<{ scope: string; handler: (ask: Ask) => void }>;
let settledHandlers: Set<(settled: AskSettled) => void>;

const explainJob: JobDescription = {
  id: 'explain',
  title: 'Explain a file',
  schema: { type: 'object', properties: { file: { type: 'string' } } },
  options: { file: 'choices' },
  hasPrompt: true,
};

beforeEach(async () => {
  runs = [];
  asked = [];
  runOutcome = async () => ({ action: 'started', state: 'busy' });
  endOutcome = async () => ({ action: 'ended', stoppedTasks: [] });
  followers = new Set();
  attachedSizes = [];
  live = true;
  failures = [];
  answerOutcome = async () => {};
  pendingAsks = [];
  rememberedSettled = [];
  askFollowers = new Set();
  settledHandlers = new Set();
  attachOutcome = async () => new FakeAttachment();
  handler = createHandler({
    tokenMatches: (candidate) => candidate === TOKEN,
    operations: {
      run: (jobId, args, options) => {
        runs.push({ jobId, args, options });
        return runOutcome();
      },
      async send(...given) {
        asked.push({ operation: 'send', given });
        return { action: 'sent', state: 'busy' };
      },
      async open(...given) {
        asked.push({ operation: 'open', given });
        return { action: 'resumed', state: 'idle' };
      },
      async interrupt(...given) {
        asked.push({ operation: 'interrupt', given });
        return { action: 'interrupted', state: 'idle' };
      },
      end(...given) {
        asked.push({ operation: 'end', given });
        return endOutcome();
      },
      async remove(...given) {
        asked.push({ operation: 'remove', given });
        return { action: 'nothing-to-remove' };
      },
      jobs: () => [explainJob],
      async options(...given) {
        asked.push({ operation: 'options', given });
        return [{ value: 'a.md', label: 'A' }];
      },
      answer(...given) {
        asked.push({ operation: 'answer', given });
        return answerOutcome();
      },
    },
    sessions: {
      list: () => [idle],
      follow(listener) {
        followers.add(listener);
        listener([idle]);
        return () => void followers.delete(listener);
      },
    },
    asks: {
      follow(scope, handler) {
        const follower = { scope, handler };
        askFollowers.add(follower);
        for (const ask of pendingAsks) if (scope === '*' || ask.key === scope) handler(ask);
        return () => void askFollowers.delete(follower);
      },
      on(_event, handler) {
        settledHandlers.add(handler);
        return () => void settledHandlers.delete(handler);
      },
      settled: (scope) =>
        rememberedSettled.filter((settled) => scope === '*' || settled.key === scope),
    },
    terminals: {
      attach: (_key, size) => {
        attachedSizes.push(size);
        return attachOutcome();
      },
      isLive: async () => live,
      joinHold: () => () => {},
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
  it.each([
    ['GET', SESSIONS_PATH],
    ['POST', RUN_PATH],
    ['POST', SEND_PATH],
    ['POST', OPEN_PATH],
    ['POST', INTERRUPT_PATH],
    ['POST', END_PATH],
    ['POST', REMOVE_PATH],
    ['GET', JOBS_PATH],
    ['POST', OPTIONS_PATH],
    ['POST', ASKS_ANSWER_PATH],
    ['GET', FOLLOW_SESSIONS_PATH],
    ['GET', FOLLOW_ASKS_PATH],
    ['GET', terminalPath(idle.key)],
    ['GET', '/nothing'],
  ])(
    'refuses %s %s without the token, before any route is told: no-token',
    async (method, path) => {
      // A body each operation would take, so that only the missing token refuses it.
      const body = JSON.stringify({
        jobId: 'explain',
        args: {},
        key: idle.key,
        prompt: 'Hi',
        field: 'file',
      });

      const reply = await call(`${base}${path}`, method === 'POST' ? { method, body } : { method });

      expect(reply.status).toBe(401);
      expect(errorOf(reply.body)).toMatchObject({ name: 'CockpitError', code: 'no-token' });
      expect(runs).toEqual([]);
      expect(asked).toEqual([]);
    },
  );

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

  it.each([FOLLOW_ASKS_PATH, `${FOLLOW_ASKS_PATH}?key=explain-a`])(
    'refuses a handshake on %s without the token, and with another token: no-token',
    async (path) => {
      const without = await openSocket(ws(path));
      const another = await openSocket(ws(path), { token: 'not-it' });

      for (const outcome of [without, another]) {
        expect(outcome).toMatchObject({ refused: { status: 401 } });
        expect('refused' in outcome && errorOf(outcome.refused.body)).toMatchObject({
          code: 'no-token',
        });
      }
      expect(askFollowers.size).toBe(0);
      expect(settledHandlers.size).toBe(0);
    },
  );

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
    expect(runs).toEqual([{ jobId: 'explain', args: { file: 'a' }, options: {} }]);
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

  it('runs a job afresh when the body asks', async () => {
    await post(`${base}/run`, { jobId: 'explain', args: {}, fresh: true }, { token: TOKEN });

    expect(runs).toEqual([{ jobId: 'explain', args: {}, options: { fresh: true } }]);
  });

  it('sends a prompt to a unit of work and answers what the send did', async () => {
    const reply = await post(
      `${base}/send`,
      { key: 'explain-a', prompt: 'Go on.' },
      { token: TOKEN },
    );

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ action: 'sent', state: 'busy' });
    expect(asked).toEqual([{ operation: 'send', given: ['explain-a', 'Go on.'] }]);
  });

  it('opens a unit of work, afresh when the body asks, and answers what the open did', async () => {
    const reply = await post(`${base}/open`, { key: 'explain-a' }, { token: TOKEN });
    await post(`${base}/open`, { key: 'explain-a', fresh: true }, { token: TOKEN });

    expect(JSON.parse(reply.body)).toEqual({ action: 'resumed', state: 'idle' });
    expect(asked).toEqual([
      { operation: 'open', given: ['explain-a', {}] },
      { operation: 'open', given: ['explain-a', { fresh: true }] },
    ]);
  });

  it.each([
    [INTERRUPT_PATH, 'interrupt', { action: 'interrupted', state: 'idle' }],
    [END_PATH, 'end', { action: 'ended', stoppedTasks: [] }],
    [REMOVE_PATH, 'remove', { action: 'nothing-to-remove' }],
  ])(
    'on POST %s, asks the %s of the key and answers what it did',
    async (path, operation, result) => {
      const reply = await post(`${base}${path}`, { key: 'explain-a' }, { token: TOKEN });

      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual(result);
      expect(asked).toEqual([{ operation, given: ['explain-a'] }]);
    },
  );

  it.each([INTERRUPT_PATH, END_PATH, REMOVE_PATH])(
    'refuses a body with no key on POST %s: invalid-arguments, nothing asked',
    async (path) => {
      for (const body of ['not json', '{}', '{"key":3}']) {
        const reply = await call(`${base}${path}`, { method: 'POST', body, token: TOKEN });

        expect(reply.status).toBe(400);
        expect(errorOf(reply.body)).toMatchObject({ code: 'invalid-arguments' });
      }
      expect(asked).toEqual([]);
    },
  );

  it('answers a refused end with the error and its status', async () => {
    endOutcome = async () => {
      throw new CockpitError('wrong-state', 'Starting.', { key: 'explain-a', state: 'starting' });
    };

    const reply = await post(`${base}${END_PATH}`, { key: 'explain-a' }, { token: TOKEN });

    expect(reply.status).toBe(409);
    expect(errorOf(reply.body)).toMatchObject({ code: 'wrong-state', state: 'starting' });
    expect(failures).toEqual([]);
  });

  it('answers an end whose kill failed 500, with nothing of it, and reports it to the app', async () => {
    const failed = new SessionHostError('host-failed', 'tmux could not kill the session.');
    endOutcome = async () => {
      throw failed;
    };

    const reply = await post(`${base}${END_PATH}`, { key: 'explain-a' }, { token: TOKEN });

    expect(reply).toMatchObject({ status: 500, body: '' });
    expect(failures).toEqual([{ where: 'handler', cause: failed }]);
  });

  it('describes the jobs', async () => {
    const reply = await call(`${base}/jobs`, { token: TOKEN });

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ jobs: [explainJob] });
  });

  it('reads a field’s choices, given the arguments filled so far', async () => {
    const reply = await post(
      `${base}/options`,
      { jobId: 'explain', field: 'file', args: { folder: 'docs' } },
      { token: TOKEN },
    );

    expect(JSON.parse(reply.body)).toEqual({ choices: [{ value: 'a.md', label: 'A' }] });
    expect(asked).toEqual([
      { operation: 'options', given: ['explain', 'file', { folder: 'docs' }] },
    ]);
  });

  it.each([
    ['/run', '{"jobId":"explain","args":{},"fresh":"yes"}', ['fresh']],
    ['/send', '{"prompt":"Go on."}', ['key']],
    ['/send', '{"key":"explain-a","prompt":3}', ['prompt']],
    ['/open', '{}', ['key']],
    ['/open', '{"key":"explain-a","fresh":1}', ['fresh']],
    ['/options', '{"field":"file","args":{}}', ['jobId']],
    ['/options', '{"jobId":"explain","args":{}}', ['field']],
    ['/send', 'not json', []],
  ])(
    'refuses a body of %s that does not fit, at its field: invalid-arguments',
    async (path, body, at) => {
      const reply = await call(`${base}${path}`, { method: 'POST', body, token: TOKEN });

      expect(reply.status).toBe(400);
      expect(errorOf(reply.body)).toMatchObject({
        code: 'invalid-arguments',
        issues: [{ path: at }],
      });
      expect([...runs, ...asked]).toEqual([]);
    },
  );

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

const permission: Ask = {
  id: 'ask-1',
  key: 'explain-a',
  kind: 'permission',
  tool: 'Bash',
  input: { command: 'ls' },
  answerable: 'app',
  since: '2026-11-28T10:00:00.000Z',
};
const otherKeysAsk: Ask = { ...permission, id: 'ask-2', key: 'explain-b' };

describe('answering an ask', () => {
  it('gives the operation the id and the answer as sent, and answers 204 with no body', async () => {
    const answer = { allow: false, message: 'Not that one.' };

    const reply = await post(
      `${base}${ASKS_ANSWER_PATH}`,
      { id: 'ask-1', answer },
      { token: TOKEN },
    );

    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expect(asked).toEqual([{ operation: 'answer', given: ['ask-1', answer] }]);
  });

  it('leaves the answer’s checks to the operation: an answer of no shape is given as it is', async () => {
    await post(`${base}${ASKS_ANSWER_PATH}`, { id: 'ask-1', answer: 'yes' }, { token: TOKEN });
    await post(`${base}${ASKS_ANSWER_PATH}`, { id: 'ask-1' }, { token: TOKEN });

    expect(asked).toEqual([
      { operation: 'answer', given: ['ask-1', 'yes'] },
      { operation: 'answer', given: ['ask-1', undefined] },
    ]);
  });

  it.each([
    [404, new CockpitError('unknown-id', 'No ask has this id.', { id: 'ask-1' })],
    [409, new CockpitError('already-settled', 'Settled.', { id: 'ask-1', by: 'terminal' })],
    [409, new CockpitError('terminal-only', 'Terminal only.', { id: 'ask-1' })],
    [
      400,
      new CockpitError('invalid-answer', 'Does not fit.', {
        id: 'ask-1',
        issues: [{ path: ['allow'], message: 'Expected a boolean.' }],
      }),
    ],
  ])('answers a refusal %i with the error, its code and its fields', async (status, refusal) => {
    answerOutcome = async () => {
      throw refusal;
    };

    const reply = await post(
      `${base}${ASKS_ANSWER_PATH}`,
      { id: 'ask-1', answer: { allow: true } },
      { token: TOKEN },
    );

    expect(reply.status).toBe(status);
    expect(errorOf(reply.body)).toEqual(refusal.toJSON());
  });

  it('refuses a body with no id as the request’s arguments, the operation not asked', async () => {
    const reply = await post(
      `${base}${ASKS_ANSWER_PATH}`,
      { answer: { allow: true } },
      { token: TOKEN },
    );

    expect(reply.status).toBe(400);
    expect(errorOf(reply.body)).toMatchObject({ code: 'invalid-arguments' });
    expect(asked).toEqual([]);
  });
});

describe('following the asks', () => {
  /** The messages a follower of the asks receives, parsed, from the first. */
  async function asksFollower(path: string): Promise<{
    opened: OpenSocket;
    next: (count: number) => Promise<unknown[]>;
  }> {
    const opened = await openedSocket(ws(path), { token: TOKEN });
    return {
      opened,
      next: async (count) => {
        await opened.next(() => opened.messages.length >= count);
        return opened.messages.slice(0, count).map((message) => JSON.parse(String(message)));
      },
    };
  }

  it('sends where the asks stand at once, then each ask and each settlement, until the socket closes', async () => {
    pendingAsks = [permission, otherKeysAsk];
    rememberedSettled = [{ id: 'ask-0', key: 'explain-b', by: 'app' }];
    const follower = await asksFollower(FOLLOW_ASKS_PATH);
    expect(await follower.next(1)).toEqual([
      { type: 'asks', pending: [permission, otherKeysAsk], settled: rememberedSettled },
    ]);
    expect([...askFollowers].map(({ scope }) => scope)).toEqual(['*']);

    const changed: Ask = { ...permission, answerable: 'terminal' };
    for (const { handler } of askFollowers) handler(changed);
    for (const handler of settledHandlers)
      handler({ id: 'ask-2', key: 'explain-b', by: 'cancelled' });

    expect((await follower.next(3)).slice(1)).toEqual([
      { type: 'ask', ask: changed },
      { type: 'settled', id: 'ask-2', key: 'explain-b', by: 'cancelled' },
    ]);
    follower.opened.socket.close();
    await eventually(() => expect(askFollowers.size + settledHandlers.size).toBe(0));
  });

  it('follows one session’s asks with ?key=: its own, and its own settlements alone', async () => {
    pendingAsks = [permission, otherKeysAsk];
    rememberedSettled = [
      { id: 'ask-0', key: 'explain-b', by: 'app' },
      { id: 'ask-9', key: 'explain-a', by: 'terminal' },
    ];
    const follower = await asksFollower(`${FOLLOW_ASKS_PATH}?key=explain-a`);
    expect(await follower.next(1)).toEqual([
      {
        type: 'asks',
        pending: [permission],
        settled: [{ id: 'ask-9', key: 'explain-a', by: 'terminal' }],
      },
    ]);
    expect([...askFollowers].map(({ scope }) => scope)).toEqual(['explain-a']);

    for (const handler of settledHandlers) handler({ id: 'ask-2', key: 'explain-b', by: 'app' });
    for (const handler of settledHandlers) handler({ id: 'ask-1', key: 'explain-a', by: 'app' });

    expect((await follower.next(2)).slice(1)).toEqual([
      { type: 'settled', id: 'ask-1', key: 'explain-a', by: 'app' },
    ]);
    follower.opened.socket.close();
  });

  it('refuses a handshake for a key that is no key, 404', async () => {
    expect(await openSocket(ws(`${FOLLOW_ASKS_PATH}?key=A`), { token: TOKEN })).toMatchObject({
      refused: { status: 404 },
    });
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
