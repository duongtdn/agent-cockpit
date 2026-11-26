import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createCockpitClient as CreateCockpitClient } from '../../src/client/index.ts';
import {
  loadAfresh,
  MemoryStorage,
  openPage,
  RefusedStorage,
  STORED_TOKEN_KEY,
} from '../support/browser-page.ts';
import { json, startWireServer, type WireServer } from '../support/wire-server.ts';

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';
const otherToken = 'Zz9_another-token-0123456789abcdefABCDEF-xy';

let server: WireServer;
/** The client's factory, loaded afresh for each test's page. */
let createCockpitClient: typeof CreateCockpitClient;

/** Loads the client as a page newly opened does: it knows no token yet. */
async function loadClient(): Promise<typeof CreateCockpitClient> {
  return (await loadAfresh(() => import('../../src/client/index.ts'))).createCockpitClient;
}

beforeEach(async () => {
  createCockpitClient = await loadClient();
  server = await startWireServer();
  server.answer('/run', json(200, { action: 'started', state: 'busy' }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

/** The token the server received with the client's next call. */
async function tokenSent(client: ReturnType<typeof createCockpitClient>): Promise<unknown> {
  await client.run('explain', {});
  return server.requests.at(-1)?.token;
}

describe('the token from the link', () => {
  it('is taken from the fragment and sent with every call', async () => {
    openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
    const client = createCockpitClient({ baseUrl: server.baseUrl });

    expect(await tokenSent(client)).toBe(token);
    expect(await tokenSent(client)).toBe(token);
  });

  it('leaves the address bar at once, keeping the history entry and its state', () => {
    const page = openPage(`http://127.0.0.1:8765/books?id=3#cockpit=${token}`, {
      state: { tab: 'sessions' },
    });

    createCockpitClient({ baseUrl: server.baseUrl });

    expect(page.address()).toBe('http://127.0.0.1:8765/books?id=3');
    expect(page.historyState()).toEqual({ tab: 'sessions' });
  });

  it("leaves the rest of the fragment to the app's own routes", () => {
    const page = openPage(`http://127.0.0.1:8765/#/chapters/3&cockpit=${token}&x=1`);

    createCockpitClient({ baseUrl: server.baseUrl });

    expect(page.address()).toBe('http://127.0.0.1:8765/#/chapters/3&x=1');
  });

  it('leaves an address without the token as it is', () => {
    const page = openPage('http://127.0.0.1:8765/#/chapters/3');

    createCockpitClient({ baseUrl: server.baseUrl });

    expect(page.address()).toBe('http://127.0.0.1:8765/#/chapters/3');
  });

  it("is kept in the origin's local storage", () => {
    const page = openPage(`http://127.0.0.1:8765/#cockpit=${token}`);

    createCockpitClient({ baseUrl: server.baseUrl });

    expect(page.storage.getItem(STORED_TOKEN_KEY)).toBe(token);
  });

  it('is found again after a reload, without the link', async () => {
    const storage = new MemoryStorage();
    openPage(`http://127.0.0.1:8765/#cockpit=${token}`, { storage });
    createCockpitClient({ baseUrl: server.baseUrl });

    openPage('http://127.0.0.1:8765/', { storage });
    const reloaded = (await loadClient())({ baseUrl: server.baseUrl });

    expect(await tokenSent(reloaded)).toBe(token);
  });

  it('replaces the one kept when the link carries another', async () => {
    const storage = new MemoryStorage();
    storage.setItem(STORED_TOKEN_KEY, otherToken);
    openPage(`http://127.0.0.1:8765/#cockpit=${token}`, { storage });

    expect(await tokenSent(createCockpitClient({ baseUrl: server.baseUrl }))).toBe(token);
  });

  it('is taken from the storage at each call, so a link opened in another tab serves this one', async () => {
    const page = openPage('http://127.0.0.1:8765/');
    const client = createCockpitClient({ baseUrl: server.baseUrl });

    page.storage.setItem(STORED_TOKEN_KEY, token);

    expect(await tokenSent(client)).toBe(token);
  });

  it('still serves the page when the browser refuses it local storage', async () => {
    openPage(`http://127.0.0.1:8765/#cockpit=${token}`, { storage: new RefusedStorage() });

    expect(await tokenSent(createCockpitClient({ baseUrl: server.baseUrl }))).toBe(token);
  });

  it('is shared by every taker on the page: the first one leaves no token in the address', async () => {
    openPage(`http://127.0.0.1:8765/#cockpit=${token}`, { storage: new RefusedStorage() });
    createCockpitClient({ baseUrl: server.baseUrl });

    expect(await tokenSent(createCockpitClient({ baseUrl: server.baseUrl }))).toBe(token);
  });

  it('is not sent when none was given: the server says why', async () => {
    openPage('http://127.0.0.1:8765/');

    expect(await tokenSent(createCockpitClient({ baseUrl: server.baseUrl }))).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['holding a character a subprotocol cannot carry', 'a/b='],
  ])('is ignored when it is %s, and still leaves the address bar', async (_, value) => {
    const page = openPage(`http://127.0.0.1:8765/#cockpit=${value}`);
    const client = createCockpitClient({ baseUrl: server.baseUrl });

    expect(page.address()).toBe('http://127.0.0.1:8765/');
    expect(page.storage.getItem(STORED_TOKEN_KEY)).toBeNull();
    expect(await tokenSent(client)).toBeUndefined();
  });

  it('is ignored when what the storage holds cannot be a token', async () => {
    const storage = new MemoryStorage();
    storage.setItem(STORED_TOKEN_KEY, 'not a token');
    openPage('http://127.0.0.1:8765/', { storage });

    expect(await tokenSent(createCockpitClient({ baseUrl: server.baseUrl }))).toBeUndefined();
  });
});

describe("the token on the app's own routes", () => {
  /** The headers function, loaded afresh for each test's page as the client is. */
  async function loadHeaders() {
    return (await loadAfresh(() => import('../../src/client/index.ts'))).cockpitHeaders;
  }

  it('is the header the app sends with its own requests, taken from the link', async () => {
    const page = openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
    const cockpitHeaders = await loadHeaders();

    expect(cockpitHeaders()).toEqual({ 'cockpit-token': token });
    expect(page.address()).toBe('http://127.0.0.1:8765/');
  });

  it('is the one the storage keeps, read at each call', async () => {
    const page = openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
    const cockpitHeaders = await loadHeaders();
    cockpitHeaders();
    page.storage.setItem(STORED_TOKEN_KEY, otherToken);

    expect(cockpitHeaders()).toEqual({ 'cockpit-token': otherToken });
  });

  it('is no header at all when the page has no token', async () => {
    openPage('http://127.0.0.1:8765/');
    const cockpitHeaders = await loadHeaders();

    expect(cockpitHeaders()).toEqual({});
  });
});
