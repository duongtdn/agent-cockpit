import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCockpitClient, isCockpitError } from '../../src/client/index.ts';
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

/** The one request the server received, as the client sent it. */
function theRequest() {
  expect(server.requests).toHaveLength(1);
  const [request] = server.requests;
  return { ...request, body: request?.body === '' ? undefined : JSON.parse(request?.body ?? '') };
}

describe("the client's units of work", () => {
  it('runs a job afresh when asked: fresh goes with the job and its arguments', async () => {
    server.answer(
      '/run',
      json(200, { action: 'started', reason: 'fresh-on-request', state: 'busy' }),
    );

    const result = await createCockpitClient({ baseUrl: server.baseUrl }).run(
      'draft',
      { book: 'b' },
      { fresh: true },
    );

    expect(result).toEqual({ action: 'started', reason: 'fresh-on-request', state: 'busy' });
    expect(theRequest()).toMatchObject({
      method: 'POST',
      path: '/run',
      token,
      body: { jobId: 'draft', args: { book: 'b' }, fresh: true },
    });
  });

  it('sends a prompt to a key, and resolves with what the send did', async () => {
    server.answer('/send', json(200, { action: 'sent', state: 'busy' }));

    const result = await createCockpitClient({ baseUrl: server.baseUrl }).send(
      'chapter-1',
      'Tighten the second section.',
    );

    expect(result).toEqual({ action: 'sent', state: 'busy' });
    expect(theRequest()).toMatchObject({
      method: 'POST',
      path: '/send',
      token,
      body: { key: 'chapter-1', prompt: 'Tighten the second section.' },
    });
  });

  it('opens a key, fresh when asked, and resolves with what the open did', async () => {
    server.answer('/open', json(200, { action: 'nothing-to-open', state: 'idle' }));
    const client = createCockpitClient({ baseUrl: server.baseUrl });

    expect(await client.open('chapter-1')).toEqual({ action: 'nothing-to-open', state: 'idle' });
    await client.open('chapter-1', { fresh: true });

    expect(server.requests.map(({ path, body }) => [path, JSON.parse(body)])).toEqual([
      ['/open', { key: 'chapter-1' }],
      ['/open', { key: 'chapter-1', fresh: true }],
    ]);
  });

  it('describes the jobs', async () => {
    const jobs = [
      {
        id: 'draft',
        title: 'Draft a chapter',
        schema: { type: 'object', properties: { book: { type: 'string', label: 'Book' } } },
        options: { book: 'choices' },
        hasPrompt: true,
      },
    ];
    server.answer('/jobs', json(200, { jobs }));

    expect(await createCockpitClient({ baseUrl: server.baseUrl }).jobs()).toEqual(jobs);
    expect(theRequest()).toMatchObject({ method: 'GET', path: '/jobs', token, body: undefined });
  });

  it("reads a field's choices, given the arguments filled so far", async () => {
    const choices = [{ value: 'ch-1', label: 'Chapter 1' }, { value: 'ch-2' }];
    server.answer('/options', json(200, { choices }));

    const read = await createCockpitClient({ baseUrl: server.baseUrl }).options(
      'draft',
      'chapter',
      { book: 'b' },
    );

    expect(read).toEqual(choices);
    expect(theRequest()).toMatchObject({
      method: 'POST',
      path: '/options',
      token,
      body: { jobId: 'draft', field: 'chapter', args: { book: 'b' } },
    });
  });

  it('reads choices with no arguments filled as an empty object of them', async () => {
    server.answer('/options', json(200, { choices: [] }));

    await createCockpitClient({ baseUrl: server.baseUrl }).options('draft', 'book');

    expect(theRequest().body).toEqual({ jobId: 'draft', field: 'book', args: {} });
  });

  it("rejects with the server's error, as run does", async () => {
    server.answer(
      '/send',
      json(404, {
        error: { name: 'CockpitError', code: 'unknown-key', message: 'No unit.', key: 'k' },
      }),
    );

    const error = await createCockpitClient({ baseUrl: server.baseUrl })
      .send('k', 'p')
      .catch((reason: unknown) => reason);

    expect(isCockpitError(error, 'unknown-key')).toBe(true);
    expect(error).toMatchObject({ key: 'k' });
  });
});
