import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CockpitClient,
  type CockpitError,
  createCockpitClient,
  type Session,
} from '../../src/client/index.ts';
import { loadAfresh, openPage } from '../support/browser-page.ts';
import { FakeWebSocket } from '../support/fake-web-socket.ts';

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';
const idle: Session = { key: 'explain-a', state: 'idle', since: '2026-11-26T10:00:05.000Z' };
const snapshot = JSON.stringify({ type: 'sessions', sessions: [idle] });

/** The client's first wait before it reconnects, and its longest. */
const FIRST_DELAY_MS = 500;
const LONGEST_DELAY_MS = 10_000;

let client: CockpitClient;
let stop: () => void;
let stopReporting: () => void;
let lists: (readonly Session[])[];
let errors: CockpitError[];

/** The server's answer to the request that explains a refused handshake. */
function noTokenAnswer(): Response {
  return Response.json(
    { error: { name: 'CockpitError', code: 'no-token', message: 'No valid token.' } },
    { status: 401 },
  );
}

/** The server's answer to a request it asks to be made again: a renewal of its token overlapped it. */
function makeAgainAnswer(): Response {
  return Response.json({ retry: true }, { status: 503, headers: { 'retry-after': '1' } });
}

/** An answer whose body breaks off while it is read: the connection was reset. */
function brokenOffAnswer(): Response {
  const body = new ReadableStream({
    start: (controller) => controller.error(new TypeError('network error')),
  });
  return new Response(body, { status: 401 });
}

beforeEach(() => {
  vi.useFakeTimers();
  openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
  FakeWebSocket.install();
  vi.stubGlobal('fetch', async () => noTokenAnswer());
  lists = [];
  errors = [];
  client = createCockpitClient({ baseUrl: '/cockpit' });
  stopReporting = client.on('error', (error) => errors.push(error));
  stop = client.sessions.follow((sessions) => lists.push(sessions));
});

afterEach(() => {
  stop();
  stopReporting();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Refuses the current handshake and lets the client explain it. */
async function refuseHandshake(): Promise<void> {
  FakeWebSocket.last().drop();
  await vi.advanceTimersByTimeAsync(0);
}

/** How many sockets the page opened by then. */
async function socketsAfter(milliseconds: number): Promise<number> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  return FakeWebSocket.created.length;
}

describe('sessions.follow, across drops', () => {
  it('opens the WebSocket of the follow path, resolved against the page', () => {
    expect(FakeWebSocket.created).toHaveLength(1);
    expect(FakeWebSocket.last().url).toBe('ws://127.0.0.1:8765/cockpit/follow/sessions');
  });

  it('reconnects after a drop, once the first delay has passed, and delivers the list again', async () => {
    FakeWebSocket.last().accept();
    FakeWebSocket.last().deliver(snapshot);
    FakeWebSocket.last().drop();

    expect(await socketsAfter(FIRST_DELAY_MS - 1)).toBe(1);
    expect(await socketsAfter(1)).toBe(2);
    FakeWebSocket.last().accept();
    FakeWebSocket.last().deliver(snapshot);

    expect(lists).toEqual([[idle], [idle]]);
    expect(errors).toEqual([]);
  });

  it('waits twice as long after each failed attempt, up to a bound', async () => {
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await refuseHandshake();
      const before = FakeWebSocket.created.length;
      let waited = 0;
      while (FakeWebSocket.created.length === before) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      waits.push(waited);
    }

    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    expect(Math.max(...waits)).toBe(LONGEST_DELAY_MS);
  });

  it('waits the first delay again once a list has arrived', async () => {
    await refuseHandshake();
    await socketsAfter(FIRST_DELAY_MS);
    await refuseHandshake();
    await socketsAfter(2 * FIRST_DELAY_MS);

    FakeWebSocket.last().accept();
    FakeWebSocket.last().deliver(snapshot);
    FakeWebSocket.last().drop();

    expect(await socketsAfter(FIRST_DELAY_MS)).toBe(4);
  });

  it('reports why each attempt failed, then tries again', async () => {
    await refuseHandshake();
    await socketsAfter(FIRST_DELAY_MS);
    await refuseHandshake();

    expect(errors.map((error) => error.code)).toEqual(['no-token', 'no-token']);
  });

  it('reports unreachable when the explaining request cannot reach the server either', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await refuseHandshake();

    expect(errors.map((error) => error.code)).toEqual(['unreachable']);
  });

  it('reports unreachable, and tries again, when the explaining answer breaks off as it is read', async () => {
    vi.stubGlobal('fetch', async () => brokenOffAnswer());

    await refuseHandshake();

    expect(errors.map((error) => error.code)).toEqual(['unreachable']);
    expect(await socketsAfter(FIRST_DELAY_MS)).toBe(2);
  });

  it('reports nothing for a handshake the server asked to be made again (a renewal of the token overlapped it): it only reconnects', async () => {
    vi.stubGlobal('fetch', async () => makeAgainAnswer());

    await refuseHandshake();

    expect(errors).toEqual([]);
    expect(await socketsAfter(FIRST_DELAY_MS)).toBe(2);
  });

  it('reports nothing for a drop: it only reconnects', async () => {
    FakeWebSocket.last().accept();
    FakeWebSocket.last().drop();

    expect(await socketsAfter(FIRST_DELAY_MS)).toBe(2);
    expect(errors).toEqual([]);
  });

  it('ignores a message that is no list of sessions', () => {
    FakeWebSocket.last().accept();
    FakeWebSocket.last().deliver('not json');
    FakeWebSocket.last().deliver(JSON.stringify({ type: 'activity', events: [] }));
    FakeWebSocket.last().deliver(JSON.stringify({ type: 'sessions', sessions: 'none' }));
    FakeWebSocket.last().deliver(new ArrayBuffer(2));

    expect(lists).toEqual([]);
  });

  it('closes the socket when stopped, and never reconnects', async () => {
    FakeWebSocket.last().accept();

    stop();
    FakeWebSocket.last().drop();

    expect(FakeWebSocket.last().closedByPage).toBe(true);
    expect(await socketsAfter(LONGEST_DELAY_MS)).toBe(1);
  });

  it('cancels a pending reconnection when stopped', async () => {
    await refuseHandshake();

    stop();

    expect(await socketsAfter(LONGEST_DELAY_MS)).toBe(1);
  });

  it('reports nothing and tries no more when stopped while it explains a refusal', async () => {
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (answer = resolve)));
    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(0);

    stop();
    answer(noTokenAnswer());

    expect(await socketsAfter(LONGEST_DELAY_MS)).toBe(1);
    expect(errors).toEqual([]);
  });

  it('follows without an error handler, failures and all', async () => {
    stop();
    stop = createCockpitClient({ baseUrl: '/cockpit' }).sessions.follow(() => {});

    await refuseHandshake();

    expect(await socketsAfter(FIRST_DELAY_MS)).toBe(3);
  });

  it('tells every error handler, and none that was removed', async () => {
    const others: CockpitError[] = [];
    const stopOther = client.on('error', (error) => others.push(error));

    await refuseHandshake();
    stopReporting();
    await socketsAfter(FIRST_DELAY_MS);
    await refuseHandshake();
    stopOther();

    expect(errors.map((error) => error.code)).toEqual(['no-token']);
    expect(others.map((error) => error.code)).toEqual(['no-token', 'no-token']);
  });

  it('tells every error handler, and tries again, though one throws; the throw goes to the console', async () => {
    const thrown = new Error('the app’s handler failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stopReporting();
    const stopThrowing = client.on('error', () => {
      throw thrown;
    });
    stopReporting = client.on('error', (error) => errors.push(error));

    await refuseHandshake();
    await socketsAfter(FIRST_DELAY_MS);
    await refuseHandshake();
    stopThrowing();

    expect(errors.map((error) => error.code)).toEqual(['no-token', 'no-token']);
    expect(FakeWebSocket.created).toHaveLength(2);
    expect(consoleError.mock.calls.map((call) => call.at(-1))).toEqual([thrown, thrown]);
    consoleError.mockRestore();
  });

  it('keeps an error handler removed once removed, when removed twice', async () => {
    stopReporting();
    stopReporting();

    await refuseHandshake();

    expect(errors).toEqual([]);
  });

  it('reconnects at once with the token of a new link opened in the tab', async () => {
    stop();
    const page = openPage('http://127.0.0.1:8765/');
    const fresh = await loadAfresh(() => import('../../src/client/index.ts'));
    stop = fresh.createCockpitClient({ baseUrl: '/cockpit' }).sessions.follow(() => {});
    await refuseHandshake();
    const refused = FakeWebSocket.last();

    page.followFragment(`cockpit=${token}`);

    expect(refused.closedByPage).toBe(true);
    expect(FakeWebSocket.created).toHaveLength(3);
    expect(FakeWebSocket.last().protocols).toEqual([
      'agent-cockpit',
      `agent-cockpit.token.${token}`,
    ]);
    expect(await socketsAfter(LONGEST_DELAY_MS)).toBe(3);
  });

  it('drops the socket it replaced for a new link, and what it says', async () => {
    stop();
    const page = openPage('http://127.0.0.1:8765/');
    const fresh = await loadAfresh(() => import('../../src/client/index.ts'));
    const followed: (readonly Session[])[] = [];
    stop = fresh
      .createCockpitClient({ baseUrl: '/cockpit' })
      .sessions.follow((sessions) => followed.push(sessions));
    const replaced = FakeWebSocket.last();
    replaced.accept();

    page.followFragment(`cockpit=${token}`);
    replaced.deliver(snapshot);
    replaced.drop();

    expect(followed).toEqual([]);
    expect(await socketsAfter(LONGEST_DELAY_MS)).toBe(3);
  });

  it('stops listening for new links once stopped', async () => {
    stop();
    const page = openPage('http://127.0.0.1:8765/');
    const fresh = await loadAfresh(() => import('../../src/client/index.ts'));
    fresh.createCockpitClient({ baseUrl: '/cockpit' }).sessions.follow(() => {})();

    page.followFragment(`cockpit=${token}`);

    expect(FakeWebSocket.created).toHaveLength(2);
  });

  it('stays stopped when stopped twice', () => {
    stop();

    expect(() => stop()).not.toThrow();
  });
});
