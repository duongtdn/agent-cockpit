import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Ask,
  type AskSettled,
  type CockpitClient,
  CockpitError,
  createCockpitClient,
} from '../../src/client/index.ts';
import {
  ASKS_ANSWER_PATH,
  type AsksServerMessage,
  wireSubprotocols,
} from '../../src/shared/wire.ts';
import { openPage } from '../support/browser-page.ts';
import { FakeWebSocket } from '../support/fake-web-socket.ts';
import { json, startWireServer, type WireServer } from '../support/wire-server.ts';

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';

/** The client's first wait before it reconnects. */
const FIRST_DELAY_MS = 500;

const bash: Ask = {
  id: 'ask-1',
  key: 'explain-a',
  kind: 'permission',
  tool: 'Bash',
  input: { command: 'ls', description: 'Lists the files' },
  description: 'Lists the files',
  answerable: 'app',
  since: '2026-11-28T10:00:00.000Z',
};
const write: Ask = {
  ...bash,
  id: 'ask-2',
  tool: 'Write',
  input: { file_path: '/app/a.md', content: 'A' },
  since: '2026-11-28T10:00:01.000Z',
};
const otherKeys: Ask = { ...bash, id: 'ask-3', key: 'explain-b' };

/** What the server sends, as text. */
function sent(message: AsksServerMessage): string {
  return JSON.stringify(message);
}

function snapshot(pending: readonly Ask[], settled: readonly AskSettled[] = []): string {
  return sent({ type: 'asks', pending, settled });
}

describe('asks.follow, over the asks’ WebSocket', () => {
  let client: CockpitClient;
  let stops: (() => void)[];
  let settlements: AskSettled[];
  let errors: CockpitError[];

  beforeEach(() => {
    vi.useFakeTimers();
    openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
    FakeWebSocket.install();
    vi.stubGlobal('fetch', async () =>
      Response.json(
        { error: { name: 'CockpitError', code: 'no-token', message: 'No valid token.' } },
        { status: 401 },
      ),
    );
    client = createCockpitClient({ baseUrl: '/cockpit' });
    settlements = [];
    errors = [];
    stops = [
      client.asks.on('settled', (settled) => settlements.push(settled)),
      client.on('error', (error) => errors.push(error)),
    ];
  });

  afterEach(() => {
    for (const stop of stops) stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Follows a scope; the asks its handler receives, in order. */
  function follow(scope: string): Ask[] {
    const asks: Ask[] = [];
    stops.push(client.asks.follow(scope, (ask) => asks.push(ask)));
    return asks;
  }

  /** The current socket is accepted and receives these messages. */
  function connectedWith(...messages: string[]): void {
    const socket = FakeWebSocket.last();
    socket.accept();
    for (const message of messages) socket.deliver(message);
  }

  /** The current socket drops; the client reconnects after its first wait. */
  async function droppedAndReconnected(): Promise<void> {
    const before = FakeWebSocket.created.length;
    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
    expect(FakeWebSocket.created).toHaveLength(before + 1);
  }

  it('opens the asks’ path, every session’s with no query, one session’s with its key, the token in the subprotocols', () => {
    follow('*');
    follow('explain-a');

    expect(FakeWebSocket.created.map((socket) => socket.url)).toEqual([
      'ws://127.0.0.1:8765/cockpit/follow/asks',
      'ws://127.0.0.1:8765/cockpit/follow/asks?key=explain-a',
    ]);
    expect(FakeWebSocket.last().protocols).toEqual(wireSubprotocols(token));
  });

  it('refuses a key that is no key, at once', () => {
    expect(() => client.asks.follow('Explain A', () => {})).toThrow(TypeError);
    expect(FakeWebSocket.created).toEqual([]);
  });

  it('delivers each pending ask of the snapshot in order, then each new one', () => {
    const asks = follow('*');

    connectedWith(snapshot([bash, otherKeys]), sent({ type: 'ask', ask: write }));

    expect(asks).toEqual([bash, otherKeys, write]);
  });

  it('delivers an ask again when its answerable changes under the same id, never when it comes unchanged', () => {
    const asks = follow('explain-a');
    const terminalOnly: Ask = { ...bash, answerable: 'terminal' };

    connectedWith(
      snapshot([bash]),
      sent({ type: 'ask', ask: bash }),
      sent({ type: 'ask', ask: terminalOnly }),
    );

    expect(asks).toEqual([bash, terminalOnly]);
  });

  it('after a drop and reconnection, delivers only the asks new or changed', async () => {
    const asks = follow('explain-a');
    connectedWith(snapshot([bash, write]));
    const terminalOnly: Ask = { ...write, answerable: 'terminal' };
    const third: Ask = { ...bash, id: 'ask-4' };

    await droppedAndReconnected();
    connectedWith(snapshot([bash, terminalOnly, third]));

    expect(asks).toEqual([bash, write, terminalOnly, third]);
    expect(errors).toEqual([]);
  });

  it('tells each settlement of an ask it delivered, once, without its message’s type', () => {
    follow('*');

    connectedWith(
      snapshot([bash]),
      sent({ type: 'settled', id: 'ask-1', key: 'explain-a', by: 'app' }),
      sent({ type: 'settled', id: 'ask-1', key: 'explain-a', by: 'app' }),
    );

    expect(settlements).toEqual([{ id: 'ask-1', key: 'explain-a', by: 'app' }]);
  });

  it('tells no settlement of an ask it never delivered: the snapshot’s past ones included', () => {
    follow('*');

    connectedWith(
      snapshot([], [{ id: 'ask-0', key: 'explain-a', by: 'terminal' }]),
      sent({ type: 'settled', id: 'ask-9', key: 'explain-a', by: 'cancelled' }),
    );

    expect(settlements).toEqual([]);
  });

  it('tells, once, a settlement missed while dropped, from the snapshot at reconnection', async () => {
    const asks = follow('explain-a');
    connectedWith(snapshot([bash, write]));
    const missed: AskSettled = { id: 'ask-1', key: 'explain-a', by: 'terminal' };

    await droppedAndReconnected();
    connectedWith(snapshot([write], [missed]));
    await droppedAndReconnected();
    connectedWith(snapshot([write], [missed]));

    expect(settlements).toEqual([missed]);
    expect(asks).toEqual([bash, write]);
  });

  it('delivers an ask to each follow that covers it, and tells its settlement once', () => {
    const all = follow('*');
    const one = follow('explain-a');
    const [allSocket, oneSocket] = FakeWebSocket.created;
    const settled = sent({ type: 'settled', id: 'ask-1', key: 'explain-a', by: 'app' });

    for (const socket of [allSocket, oneSocket]) {
      socket?.accept();
      socket?.deliver(snapshot([bash]));
    }
    oneSocket?.deliver(settled);
    allSocket?.deliver(settled);

    expect(all).toEqual([bash]);
    expect(one).toEqual([bash]);
    expect(settlements).toEqual([{ id: 'ask-1', key: 'explain-a', by: 'app' }]);
  });

  it('tells nothing more of a follow once stopped, and closes its socket', () => {
    const asks: Ask[] = [];
    const stop = client.asks.follow('*', (ask) => asks.push(ask));
    connectedWith(snapshot([bash]));

    stop();
    FakeWebSocket.last().deliver(sent({ type: 'ask', ask: write }));
    FakeWebSocket.last().deliver(
      sent({ type: 'settled', id: 'ask-1', key: 'explain-a', by: 'app' }),
    );

    expect(asks).toEqual([bash]);
    expect(settlements).toEqual([]);
    expect(FakeWebSocket.last().closedByPage).toBe(true);
  });

  it('gives the next asks and the settlements on when a handler throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const asks: Ask[] = [];
    stops.push(
      client.asks.follow('*', (ask) => {
        asks.push(ask);
        throw new Error('The page broke.');
      }),
    );

    connectedWith(
      snapshot([bash, write]),
      sent({ type: 'settled', id: 'ask-1', key: 'explain-a', by: 'app' }),
    );

    expect(asks).toEqual([bash, write]);
    expect(settlements).toEqual([{ id: 'ask-1', key: 'explain-a', by: 'app' }]);
  });

  it('ignores a message that is none of the asks’', () => {
    const asks = follow('*');

    connectedWith(
      'not json',
      JSON.stringify({ type: 'sessions', sessions: [] }),
      JSON.stringify({ type: 'asks', pending: 'none', settled: [] }),
      JSON.stringify({ type: 'ask' }),
    );

    expect(asks).toEqual([]);
  });

  it('reports why a handshake was refused, then tries again', async () => {
    follow('explain-a');

    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);

    expect(errors.map((error) => error.code)).toEqual(['no-token']);
    expect(FakeWebSocket.created).toHaveLength(2);
  });

  it('stops telling a handler once it is removed, and has no event but settled', () => {
    const told: AskSettled[] = [];
    const remove = client.asks.on('settled', (settled) => told.push(settled));
    follow('*');
    connectedWith(snapshot([bash, write]));
    FakeWebSocket.last().deliver(
      sent({ type: 'settled', id: 'ask-1', key: 'explain-a', by: 'app' }),
    );

    remove();
    FakeWebSocket.last().deliver(
      sent({ type: 'settled', id: 'ask-2', key: 'explain-a', by: 'app' }),
    );

    expect(told).toEqual([{ id: 'ask-1', key: 'explain-a', by: 'app' }]);
    expect(() => client.asks.on('opened' as 'settled', () => {})).toThrow(TypeError);
  });
});

describe('asks.answer, over HTTP', () => {
  let server: WireServer;
  let client: CockpitClient;

  beforeEach(async () => {
    server = await startWireServer();
    openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
    client = createCockpitClient({ baseUrl: server.baseUrl });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  it('posts the id and the answer with the token, and resolves with nothing on 204', async () => {
    server.answer(ASKS_ANSWER_PATH, { status: 204, body: '' });

    const answered = await client.asks.answer('ask-1', { allow: true, remember: 'session' });

    expect(answered).toBeUndefined();
    expect(server.requests).toEqual([
      {
        method: 'POST',
        path: ASKS_ANSWER_PATH,
        token,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'ask-1', answer: { allow: true, remember: 'session' } }),
      },
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
        issues: [{ path: ['message'], message: 'Too long.' }],
      }),
    ],
  ])(
    'rejects a refusal %i as the CockpitError, its code and its fields',
    async (status, refusal) => {
      server.answer(ASKS_ANSWER_PATH, json(status, { error: refusal.toJSON() }));

      const rejected = await client.asks.answer('ask-1', { allow: false }).catch((error) => error);

      expect(rejected).toBeInstanceOf(CockpitError);
      expect((rejected as CockpitError).toJSON()).toEqual(refusal.toJSON());
    },
  );
});
