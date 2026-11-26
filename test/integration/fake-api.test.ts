import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  cutStream,
  type FakeApi,
  type FakeApiOptions,
  heldTurn,
  startFakeApi,
  toolUse,
  turn,
  withUsage,
} from '../support/fake-api/index.ts';

const started: FakeApi[] = [];

async function start(options?: FakeApiOptions): Promise<FakeApi> {
  const api = await startFakeApi(options);
  started.push(api);
  return api;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((api) => api.close()));
});

/** A request as the agent's conversation makes them: it offers tools. */
function conversation(text: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-test',
    max_tokens: 1024,
    stream: true,
    system: 'You are under test.',
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: text }],
    ...more,
  };
}

function post(
  api: FakeApi,
  body: unknown,
  more: { path?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${api.baseUrl}${more.path ?? '/v1/messages'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-secret-key' },
    body: JSON.stringify(body),
    ...(more.signal ? { signal: more.signal } : {}),
  });
}

type ParsedFrame = { event: string; data: { type: string } & Record<string, unknown> };

function parseFrames(stream: string): ParsedFrame[] {
  return stream
    .split('\n\n')
    .filter((frame) => frame !== '')
    .map((frame) => {
      const [eventLine = '', dataLine = ''] = frame.split('\n');
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      };
    });
}

describe('a fake API of its own', () => {
  it('listens on a loopback port no other double has', async () => {
    const [one, other] = [await start(), await start()];

    expect(one.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(other.baseUrl).not.toBe(one.baseUrl);
    expect((await fetch(`${one.baseUrl}/anything`)).status).toBe(404);
  });

  it('leaves nothing listening once closed', async () => {
    const api = await start();

    await api.close();

    await expect(fetch(`${api.baseUrl}/anything`)).rejects.toThrow();
  });

  it('ends the streams still open when it closes', async () => {
    const api = await start();
    api.script(heldTurn());
    const response = await post(api, conversation('hi'));
    const held = await api.heldRequest();

    await api.close();

    await expect(response.text()).rejects.toThrow();
    await expect(held.ended).resolves.toBe('client-gone');
  });
});

describe('scripted turns', () => {
  it('answers the conversation requests in the order scripted', async () => {
    const api = await start();
    api.script(turn('First'), turn('Second', toolUse('mcp__cockpit__reply', { text: 'hi' })));

    const first = await (await post(api, conversation('one', { stream: false }))).json();
    const second = await (await post(api, conversation('two', { stream: false }))).json();

    expect(first).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'First' }],
      stop_reason: 'end_turn',
    });
    expect(second).toMatchObject({
      content: [
        { type: 'text', text: 'Second' },
        { type: 'tool_use', name: 'mcp__cockpit__reply', input: { text: 'hi' } },
      ],
      stop_reason: 'tool_use',
    });
    expect(second.id).not.toBe(first.id);
  });

  it("answers a subagent's conversation from its own script, whatever the order its requests come in", async () => {
    const api = await start();
    api.script(turn('Main'));
    api.scriptConversation('Count the files.', turn('Sub one'), turn('Sub two'));
    const opening = (text: string) => [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>…</system-reminder>' },
          { type: 'text', text },
        ],
      },
    ];
    const textOf = async (body: unknown) => (await (await post(api, body)).json()).content[0].text;

    const sub = await textOf(
      conversation('', { stream: false, messages: opening('Count the files.') }),
    );
    const main = await textOf(conversation('start a task', { stream: false }));
    const subAgain = await textOf(
      conversation('', {
        stream: false,
        messages: [...opening('Count the files.'), { role: 'assistant', content: 'Sub one' }],
      }),
    );

    expect([sub, main, subAgain]).toEqual(['Sub one', 'Main', 'Sub two']);
    api.assertScriptUsedUp();
  });

  it('counts the answers of every conversation among those never asked for', async () => {
    const api = await start();
    api.scriptConversation('Count the files.', turn('Sub one'));

    expect(() => api.assertScriptUsedUp()).toThrow(/never asked for \(1\)/);
  });

  it('reports the usage scripted', async () => {
    const api = await start();
    api.script(withUsage(turn('Big'), { input_tokens: 150_000, output_tokens: 42 }));

    const message = await (await post(api, conversation('hi', { stream: false }))).json();

    expect(message.usage).toMatchObject({ input_tokens: 150_000, output_tokens: 42 });
  });

  it('streams the answer as server-sent events when the request asks for a stream', async () => {
    const api = await start();
    api.script(turn('Running it.', toolUse('Bash', { command: 'true' })));

    const response = await post(api, conversation('hi'));
    const frames = parseFrames(await response.text());

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(frames.map((frame) => frame.data.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(frames.every((frame) => frame.event === frame.data.type)).toBe(true);
    expect(frames[5]?.data).toMatchObject({
      delta: { type: 'input_json_delta', partial_json: '{"command":"true"}' },
    });
    expect(frames[7]?.data).toMatchObject({ delta: { stop_reason: 'tool_use' } });
  });

  it('answers with one JSON message when the request does not ask for a stream', async () => {
    const api = await start();
    api.script(turn('Plain'));

    const response = await post(api, conversation('hi', { stream: false }));

    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toMatchObject({ content: [{ type: 'text', text: 'Plain' }] });
  });
});

describe('scripted failures', () => {
  it.each([
    [529, 'overloaded_error'],
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
  ])('answers with the API error %i', async (status, errorType) => {
    const api = await start();
    api.script(apiError(status, { message: 'Scripted' }));

    const response = await post(api, conversation('hi'));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: errorType, message: 'Scripted' },
    });
  });

  it('cuts a stream after part of the turn', async () => {
    const api = await start();
    api.script(cutStream(turn('Half a sentence')));

    const response = await post(api, conversation('hi'));
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    let received = '';
    const readToTheEnd = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        received += new TextDecoder().decode(value);
      }
    };

    await expect(readToTheEnd()).rejects.toThrow();
    expect(parseFrames(received).map((frame) => frame.data.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
    ]);
  });

  it('gives no answer to a cut request that asked for no stream', async () => {
    const api = await start();
    api.script(cutStream(turn('Never seen')));

    await expect(post(api, conversation('hi', { stream: false }))).rejects.toThrow();
  });
});

describe('a held turn', () => {
  it('starts the stream, then waits for the test to release it', async () => {
    const api = await start();
    api.script(heldTurn(turn('At last')));

    const response = await post(api, conversation('think'));
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const held = await api.heldRequest();
    const beforeRelease = new TextDecoder().decode((await reader.read()).value);

    expect(parseFrames(beforeRelease).map((frame) => frame.data.type)).toEqual(['message_start']);
    expect(held.request.body).toMatchObject({ messages: [{ role: 'user', content: 'think' }] });

    held.release();
    let afterRelease = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      afterRelease += new TextDecoder().decode(chunk.value);
    }

    expect(parseFrames(afterRelease).at(-1)?.data.type).toBe('message_stop');
    expect(afterRelease).toContain('At last');
    await expect(held.ended).resolves.toBe('released');
  });

  it('ends when the client goes away', async () => {
    const api = await start();
    api.script(heldTurn());
    const interrupt = new AbortController();

    await post(api, conversation('think'), { signal: interrupt.signal });
    const held = await api.heldRequest();
    interrupt.abort();

    await expect(held.ended).resolves.toBe('client-gone');
    held.release();
  });

  it('holds the whole answer of a request that asked for no stream', async () => {
    const api = await start();
    api.script(heldTurn(turn('At last')));

    const answer = post(api, conversation('think', { stream: false }));
    (await api.heldRequest()).release();

    expect(await (await answer).json()).toMatchObject({
      content: [{ type: 'text', text: 'At last' }],
    });
  });

  it('lets a test await the second request held', async () => {
    const api = await start();
    api.script(heldTurn(), heldTurn());
    const second = api.heldRequest(2);

    await post(api, conversation('one'));
    await post(api, conversation('two'));

    expect((await second).request.body).toMatchObject({ messages: [{ content: 'two' }] });
  });
});

describe('requests that are not turns of the conversation', () => {
  it('answers a request that offers no tools without using a scripted turn', async () => {
    const api = await start();
    api.script(turn('For the conversation'));

    const side = await post(api, {
      model: 'claude-small',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'quota' }],
    });
    const answer = await (await post(api, conversation('hi', { stream: false }))).json();

    expect(await side.json()).toMatchObject({
      type: 'message',
      model: 'claude-small',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });
    expect(answer.content).toEqual([{ type: 'text', text: 'For the conversation' }]);
    expect(api.requests().map((request) => request.kind)).toEqual(['side', 'conversation']);
  });

  it('streams the answer of a side request that asks for a stream', async () => {
    const api = await start();

    const response = await post(api, { model: 'claude-small', stream: true, messages: [] });

    expect(parseFrames(await response.text()).at(-1)?.data.type).toBe('message_stop');
  });

  it('takes the rule of the test for what a side request is', async () => {
    const api = await start({ isSideRequest: (body) => body.model === 'claude-small' });
    api.script(turn('Scripted'));

    const side = await post(api, conversation('title this', { model: 'claude-small' }));
    const answer = await post(api, { model: 'claude-test', messages: [] });

    expect(parseFrames(await side.text())[2]?.data).toMatchObject({ delta: { text: 'ok' } });
    expect(await answer.json()).toMatchObject({ content: [{ type: 'text', text: 'Scripted' }] });
  });

  it('counts tokens without using a scripted turn', async () => {
    const api = await start();

    const response = await post(api, conversation('hi'), {
      path: '/v1/messages/count_tokens?beta=true',
    });

    expect(await response.json()).toEqual({ input_tokens: 10 });
    expect(api.requests()[0]).toMatchObject({ kind: 'count-tokens' });
    api.assertNothingUnexpected();
  });

  it('answers an unknown path with a 404 of the API and logs it', async () => {
    const api = await start();

    const response = await fetch(`${api.baseUrl}/v1/models`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error' },
    });
    expect(api.requests()).toEqual([
      { number: 1, kind: 'unknown', method: 'GET', path: '/v1/models', body: undefined },
    ]);
  });
});

describe('the log of requests', () => {
  it('lists the requests to paths it does not know, for a test to say which it expects', async () => {
    const api = await start();
    api.script(turn('Hello.'));

    await post(api, conversation('hi'));
    await fetch(`${api.baseUrl}/api/hello`, { method: 'HEAD' });
    await post(api, {}, { path: '/v1/models?limit=1' });

    expect(api.unknownRequests().map((request) => `${request.method} ${request.path}`)).toEqual([
      'HEAD /api/hello',
      'POST /v1/models?limit=1',
    ]);
  });

  it('keeps the method, the path and the parsed body, and no header', async () => {
    const api = await start();
    api.script(turn('ok'));

    await post(api, conversation('hi'), { path: '/v1/messages?beta=true' });

    expect(api.requests()).toEqual([
      {
        number: 1,
        kind: 'conversation',
        method: 'POST',
        path: '/v1/messages?beta=true',
        body: conversation('hi'),
      },
    ]);
    expect(JSON.stringify(api.requests())).not.toContain('sk-ant-secret-key');
  });

  it('logs a body that is not JSON as no body', async () => {
    const api = await start();

    await fetch(`${api.baseUrl}/v1/messages`, { method: 'POST', body: 'not json' });

    expect(api.requests()[0]).toMatchObject({ kind: 'side', body: undefined });
  });

  it('lets a test await a conversation request that has not arrived yet', async () => {
    const api = await start();
    api.script(turn('one'), turn('two'));
    const second = api.conversationRequest(2);

    await post(api, conversation('first'));
    await post(api, { model: 'claude-small', messages: [] });
    await post(api, conversation('second'));

    expect(await second).toMatchObject({
      number: 3,
      body: {
        system: 'You are under test.',
        tools: [{ name: 'Bash' }],
        messages: [{ role: 'user', content: 'second' }],
      },
    });
    expect((await api.conversationRequest(1)).body?.messages).toEqual([
      { role: 'user', content: 'first' },
    ]);
  });
});

describe('what the script did not foresee', () => {
  it('answers a conversation request no turn is scripted for with an API error', async () => {
    const api = await start();

    const response = await post(api, conversation('surprise'));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: {
        type: 'permission_error',
        message: expect.stringContaining('no answer scripted'),
      },
    });
  });

  it('fails the final check, naming the request and never a header', async () => {
    const api = await start();
    await post(api, conversation('surprise'));

    const check = () => api.assertNothingUnexpected();

    expect(check).toThrow(
      /conversation request 1 \(request 1, POST \/v1\/messages, model claude-test\)/,
    );
    expect(check).toThrow(/last user message: "surprise"/);
    expect(check).not.toThrow(/sk-ant-secret-key/);
  });

  it('tells of the first such request as it arrives, with the error of the final check', async () => {
    const api = await start();
    const unexpected = api.unexpectedRequest();
    api.script(turn('ok'));
    await post(api, conversation('foreseen'));

    await post(api, conversation('surprise'));
    await post(api, conversation('another'));

    const error = await unexpected;
    expect(error.message).toMatch(/Conversation requests with no scripted answer \(1\)/);
    expect(error.message).toMatch(/conversation request 2 .*last user message: "surprise"/);
    expect(await api.unexpectedRequest()).toBe(error);
  });

  it('passes the final check when every conversation request had its answer', async () => {
    const api = await start();
    api.script(turn('ok'));
    await post(api, conversation('hi'));
    await post(api, { model: 'claude-small', messages: [] });

    api.assertNothingUnexpected();
    api.assertScriptUsedUp();
  });

  it('answers with the fallback turn a demo gives when the script holds none, and finds nothing unexpected', async () => {
    const api = await start({ fallback: turn('The one answer') });
    api.script(turn('Scripted first'));

    const first = await (await post(api, conversation('one', { stream: false }))).json();
    const second = await (await post(api, conversation('two', { stream: false }))).json();
    const third = await (await post(api, conversation('three', { stream: false }))).json();

    expect(first.content).toEqual([{ type: 'text', text: 'Scripted first' }]);
    expect(second.content).toEqual([{ type: 'text', text: 'The one answer' }]);
    expect(third.content).toEqual([{ type: 'text', text: 'The one answer' }]);
    expect(third.id).not.toBe(second.id);
    api.assertNothingUnexpected();
  });

  it('reports the scripted answers left unused, on demand', async () => {
    const api = await start();
    api.script(turn('used'), turn('Left over', toolUse('Bash')), apiError(529), heldTurn());
    await post(api, conversation('hi'));

    expect(() => api.assertScriptUsedUp()).toThrow(
      /Scripted answers never asked for \(3\):\n {2}turn\(text "Left over", tool_use Bash\)\n {2}error 529 overloaded_error\n {2}held turn\(text "ok"\)/,
    );
    api.assertNothingUnexpected();
  });
});
