import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportSessionStart } from '../../src/claude-code/session-start-hook.ts';

const HOOK = fileURLToPath(new URL('../../src/claude-code/session-start-hook.ts', import.meta.url));
const TOKEN = 'the-token-of-the-launch';
const PAYLOAD = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' });

interface Received {
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let folder: string;
let server: Server | undefined;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-session-start-'));
});

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  rmSync(folder, { recursive: true, force: true });
});

/** A listener that answers every request with a status, and keeps what it received. */
async function listen(status: number): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({ url: request.url, headers: request.headers, body });
      response.writeHead(status, { 'content-type': 'application/json' }).end('{"a":"b"}');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/agent/hooks`, received };
}

function writeAddress(url: string): string {
  const file = join(folder, 'hook-address.json');
  writeFileSync(file, JSON.stringify({ url, token: TOKEN }), { mode: 0o600 });
  return file;
}

/** Runs the hook as Claude Code does: a program of its own, the payload on its input. */
function runHook(
  args: readonly string[],
): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env: { PATH: process.env.PATH } });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk;
    });
    child.on('close', (status) => resolve({ status, out, err }));
    child.stdin.end(PAYLOAD);
  });
}

describe('the SessionStart hook, run as a program', () => {
  it('posts its input to the address of its file, with the token, and prints nothing', async () => {
    const { url, received } = await listen(200);

    const run = await runHook([writeAddress(url)]);

    expect(run).toEqual({ status: 0, out: '', err: '' });
    expect(received).toEqual([
      {
        url: '/agent/hooks',
        headers: expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        }),
        body: PAYLOAD,
      },
    ]);
  });

  it('fails with status 1, saying why, when the cockpit refuses the report', async () => {
    const { url } = await listen(401);

    const run = await runHook([writeAddress(url)]);

    expect(run).toEqual({ status: 1, out: '', err: expect.stringMatching(/answered 401/) });
  });

  it('fails with status 1 when the cockpit cannot be reached', async () => {
    const { url } = await listen(200);
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;

    const run = await runHook([writeAddress(url)]);

    expect(run).toMatchObject({ status: 1, out: '' });
  });

  it('fails with status 1 without its address file, or when given none', async () => {
    expect(await runHook([join(folder, 'absent.json')])).toMatchObject({ status: 1, out: '' });
    expect(await runHook([])).toMatchObject({
      status: 1,
      err: expect.stringMatching(/no address file/),
    });
  });
});

describe('the report of a SessionStart', () => {
  it('posts the payload as it is, and rejects on a refusal', async () => {
    const accepting = await listen(204);
    await reportSessionStart(writeAddress(accepting.url), PAYLOAD);
    expect(accepting.received.map((request) => request.body)).toEqual([PAYLOAD]);
    await new Promise((resolve) => server?.close(resolve));

    const refusing = await listen(500);
    await expect(reportSessionStart(writeAddress(refusing.url), PAYLOAD)).rejects.toThrow(/500/);
  });
});
