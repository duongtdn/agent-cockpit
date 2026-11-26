import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CockpitError, createCockpitClient, isCockpitError } from '../../src/client/index.ts';
import { openPage } from '../support/browser-page.ts';
import { json, startWireServer, type WireServer } from '../support/wire-server.ts';

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';

let server: WireServer;

beforeEach(async () => {
  server = await startWireServer();
  openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

/** What a call rejected with; fails the test when it resolved. */
async function rejection(call: Promise<unknown>): Promise<CockpitError> {
  const error = await call.then(
    () => expect.fail('The call resolved.'),
    (reason: unknown) => reason,
  );
  if (!isCockpitError(error)) throw error;
  return error;
}

describe('run', () => {
  it('posts the job and its arguments to the mount, and resolves with what the run did', async () => {
    server.answer('/run', json(200, { action: 'started', state: 'busy' }));
    const client = createCockpitClient({ baseUrl: server.baseUrl });

    const result = await client.run('explain-a-file', { file: 'src/index.ts' });

    expect(result).toEqual({ action: 'started', state: 'busy' });
    expect(server.requests).toEqual([
      {
        method: 'POST',
        path: '/run',
        token,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'explain-a-file', args: { file: 'src/index.ts' } }),
      },
    ]);
  });

  it.each([
    ['a path, against the page', (base: URL) => base.pathname],
    ['a path ending in a slash', (base: URL) => `${base.pathname}/`],
    ['an absolute URL', (base: URL) => base.href],
  ])('reaches the mount given as %s', async (_, baseUrlOf) => {
    const base = new URL(server.baseUrl);
    openPage(`${base.origin}/books/3#cockpit=${token}`);
    server.answer('/run', json(200, { action: 'started', state: 'busy' }));

    await createCockpitClient({ baseUrl: baseUrlOf(base) }).run('explain', {});

    expect(server.requests.map(({ path }) => path)).toEqual(['/run']);
  });

  it("rejects with the server's error rebuilt: its code, its message, its fields", async () => {
    const pending = [{ kind: 'terminal', dialog: 'trust-folder' }];
    server.answer(
      '/run',
      json(409, {
        error: {
          name: 'CockpitError',
          code: 'wrong-state',
          message: 'The session of explain-a is waiting.',
          key: 'explain-a',
          state: 'waiting',
          pending,
        },
      }),
    );

    const error = await rejection(createCockpitClient({ baseUrl: server.baseUrl }).run('x', {}));

    expect(isCockpitError(error, 'wrong-state')).toBe(true);
    expect(error.message).toBe('The session of explain-a is waiting.');
    expect(error.toJSON()).toEqual({
      name: 'CockpitError',
      code: 'wrong-state',
      message: 'The session of explain-a is waiting.',
      key: 'explain-a',
      state: 'waiting',
      pending,
    });
  });

  it('rejects with no-token when the server refuses the token', async () => {
    server.answer(
      '/run',
      json(401, { error: { name: 'CockpitError', code: 'no-token', message: 'No valid token.' } }),
    );

    const error = await rejection(createCockpitClient({ baseUrl: server.baseUrl }).run('x', {}));

    expect(error.code).toBe('no-token');
  });

  it('rejects with unreachable when nothing listens', async () => {
    const { baseUrl } = server;
    await server.close();
    server = await startWireServer();

    const error = await rejection(createCockpitClient({ baseUrl }).run('x', {}));

    expect(error.code).toBe('unreachable');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it.each([
    ['a page of its own', { status: 502, body: '<h1>Bad gateway</h1>', contentType: 'text/html' }],
    ['JSON that is no error', json(500, { message: 'Internal error' })],
    ['an error without a code', json(500, { error: { message: 'Internal error' } })],
  ])('rejects with unreachable when what answers is not the cockpit: %s', async (_, answer) => {
    server.answer('/run', answer);

    const error = await rejection(createCockpitClient({ baseUrl: server.baseUrl }).run('x', {}));

    expect(error.code).toBe('unreachable');
    expect(error.message).toContain(String(answer.status));
  });

  it('rejects with unreachable when a success carries no JSON', async () => {
    server.answer('/run', { status: 200, body: 'ok', contentType: 'text/plain' });

    const error = await rejection(createCockpitClient({ baseUrl: server.baseUrl }).run('x', {}));

    expect(error.code).toBe('unreachable');
  });
});

describe('createCockpitClient', () => {
  it.each([
    ['no base URL', {}],
    ['a base URL that is no text', { baseUrl: 3 }],
    ['a base URL that is no URL', { baseUrl: 'http://[' }],
    ['a base URL of another scheme', { baseUrl: 'ftp://127.0.0.1/cockpit' }],
  ])('throws invalid-options for %s', (_, options) => {
    const error = (() => {
      try {
        createCockpitClient(options as never);
      } catch (thrown) {
        return thrown;
      }
      return expect.fail('createCockpitClient returned.');
    })();

    expect(isCockpitError(error, 'invalid-options')).toBe(true);
    expect(isCockpitError(error, 'invalid-options') && error.issues[0]?.path).toEqual(['baseUrl']);
  });
});
