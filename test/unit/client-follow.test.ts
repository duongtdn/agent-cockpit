import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CockpitError, createCockpitClient, type Session } from '../../src/client/index.ts';
import { FOLLOW_SESSIONS_PATH, WIRE_SUBPROTOCOL } from '../../src/shared/wire.ts';
import { openPage } from '../support/browser-page.ts';
import { json, startWireServer, type WireServer } from '../support/wire-server.ts';

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';

const starting: Session = {
  key: 'explain-a',
  state: 'starting',
  since: '2026-11-26T10:00:00.000Z',
};
const busy: Session = { key: 'explain-a', state: 'busy', since: '2026-11-26T10:00:02.000Z' };

let server: WireServer;
let stops: (() => void)[];

beforeEach(async () => {
  server = await startWireServer();
  stops = [];
  openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
});

afterEach(async () => {
  for (const stop of stops) stop();
  vi.unstubAllGlobals();
  await server.close();
});

/** Lists the handler receives, each one awaited in turn. */
function receivedLists(): {
  handler: (sessions: readonly Session[]) => void;
  next: () => Promise<readonly Session[]>;
} {
  const lists: (readonly Session[])[] = [];
  const waiting: ((sessions: readonly Session[]) => void)[] = [];
  return {
    handler: (sessions) => {
      const waiter = waiting.shift();
      if (waiter === undefined) lists.push(sessions);
      else waiter(sessions);
    },
    next: () => {
      const list = lists.shift();
      return list === undefined
        ? new Promise((resolve) => waiting.push(resolve))
        : Promise.resolve(list);
    },
  };
}

describe('sessions.follow, on a real WebSocket', () => {
  it('opens the follow path with the token as a subprotocol, never in the URL', async () => {
    const client = createCockpitClient({ baseUrl: server.baseUrl });

    stops.push(client.sessions.follow(() => {}));
    const accepted = await server.nextSocket();

    expect(accepted.path).toBe(FOLLOW_SESSIONS_PATH);
    expect(accepted.token).toBe(token);
    expect(accepted.socket.protocol).toBe(WIRE_SUBPROTOCOL);
    expect(server.requests).toEqual([]);
  });

  it('delivers the list at once, then at every change', async () => {
    const lists = receivedLists();
    stops.push(createCockpitClient({ baseUrl: server.baseUrl }).sessions.follow(lists.handler));
    const { socket } = await server.nextSocket();

    socket.send(JSON.stringify({ type: 'sessions', sessions: [starting] }));
    socket.send(JSON.stringify({ type: 'sessions', sessions: [busy] }));

    expect(await lists.next()).toEqual([starting]);
    expect(await lists.next()).toEqual([busy]);
  });

  it('closes the socket when stopped', async () => {
    const stop = createCockpitClient({ baseUrl: server.baseUrl }).sessions.follow(() => {});
    const { socket } = await server.nextSocket();
    const closed = once(socket, 'close');

    stop();

    await closed;
  });

  it('offers no token when none is kept, and lets the server say why', async () => {
    openPage('http://127.0.0.1:8765/');

    stops.push(createCockpitClient({ baseUrl: server.baseUrl }).sessions.follow(() => {}));
    const accepted = await server.nextSocket();

    expect(accepted.token).toBeUndefined();
    expect(accepted.offered).toBe(WIRE_SUBPROTOCOL);
  });

  it('explains a refused handshake by an HTTP request the same checks refuse', async () => {
    const refusal = {
      error: { name: 'CockpitError', code: 'refused', message: 'Refused.', cause: 'origin' },
    };
    server.refuseSockets(json(403, refusal));
    server.answer('/sessions', json(403, refusal));
    const client = createCockpitClient({ baseUrl: server.baseUrl });
    const errors: CockpitError[] = [];
    const reported = new Promise<void>((resolve) => {
      stops.push(
        client.on('error', (error) => {
          errors.push(error);
          resolve();
        }),
      );
    });
    stops.push(client.sessions.follow(() => {}));

    await reported;

    expect(errors.map((error) => error.toJSON())).toEqual([refusal.error]);
    expect(server.requests).toMatchObject([{ method: 'GET', path: '/sessions', token }]);
  });

  it('reports unreachable when the HTTP request passes but the WebSocket does not', async () => {
    server.refuseSockets({ status: 502, body: '' });
    server.answer('/sessions', json(200, { sessions: [] }));
    const client = createCockpitClient({ baseUrl: server.baseUrl });
    const reported = new Promise<CockpitError>((resolve) => {
      stops.push(client.on('error', resolve));
    });
    stops.push(client.sessions.follow(() => {}));

    expect((await reported).code).toBe('unreachable');
  });
});
