import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { stop } from '../support/fake-agent/hook-events.ts';
import { createHookRunner, type HookRunner } from '../support/fake-agent/hook-runner.ts';
import { parseHookSettings } from '../support/fake-agent/hook-settings.ts';

const session = {
  sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
  cwd: tmpdir(),
  transcriptPath: '/config/projects/-work/6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11.jsonl',
  permissionMode: 'default',
};
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Starts a server on the loopback interface that answers every request as told; gives its address. */
async function serverThat(answer: RequestListener): Promise<string> {
  const server = createServer(answer);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

/** Gives an address of the loopback interface where nothing listens any more. */
async function addressThatDoesNotAnswer(): Promise<string> {
  const address = await serverThat(() => {});
  const server = servers.pop() as Server;
  await new Promise((resolve) => server.close(resolve));
  return address;
}

/** A runner whose settings give `Stop` one hook. */
function runnerWith(hook: object): HookRunner {
  const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } });
  return createHookRunner(parseHookSettings(settings), session);
}

const fireStop = (runner: HookRunner, signal?: AbortSignal) => runner.fire(stop('Done.'), signal);
const commandHook = (command: string) => runnerWith({ type: 'command', command });
const httpHook = (url: string) => runnerWith({ type: 'http', url });

describe("the runner of the fake agent's hooks", () => {
  it('gives what a command hook printed and what an HTTP hook was answered, as JSON', async () => {
    const url = await serverThat((_request, response) => response.end('{"from":"http"}'));

    expect(await fireStop(commandHook(`echo '{"from":"command"}'`))).toEqual([{ from: 'command' }]);
    expect(await fireStop(httpHook(url))).toEqual([{ from: 'http' }]);
  });

  it('reads a command hook that succeeds and prints nothing as one with no answer', async () => {
    expect(await fireStop(commandHook('cat > /dev/null'))).toEqual([{}]);
  });

  it('reads an HTTP hook whose address does not answer as one with no answer: the session goes on (behavior 40)', async () => {
    expect(await fireStop(httpHook(await addressThatDoesNotAnswer()))).toEqual([{}]);
  });

  it('reads an HTTP hook whose connection is cut before any answer as one with no answer', async () => {
    const url = await serverThat((request) => request.socket.destroy());

    expect(await fireStop(httpHook(url))).toEqual([{}]);
  });

  it('reads a command hook it is told to let go of as one with no answer', async () => {
    const letGo = new AbortController();
    const fired = fireStop(commandHook('cat > /dev/null; exec tail -f /dev/null'), letGo.signal);

    letGo.abort();

    expect(await fired).toEqual([{}]);
  });

  it.each([
    [
      'a command hook that exits with a failure',
      'exit 3',
      /a Stop command hook exited with status 3/,
    ],
    [
      'a command hook that prints what is no JSON',
      'echo done',
      /a Stop command hook answered what is no JSON: "done\\n"/,
    ],
  ])(
    'refuses %s: it does not guess what Claude Code makes of it',
    async (_what, command, problem) => {
      await expect(fireStop(commandHook(command))).rejects.toThrow(problem);
      await expect(fireStop(commandHook(command))).rejects.toThrow(
        /the fake agent does not play it$/,
      );
    },
  );

  it.each([
    [
      'is answered a status that is no success',
      500,
      '{}',
      /a Stop HTTP hook was answered the status 500/,
    ],
    [
      'is answered what is no JSON',
      200,
      'done',
      /a Stop HTTP hook answered what is no JSON: "done"/,
    ],
    ['is answered nothing', 200, '', /a Stop HTTP hook answered what is no JSON: ""/],
  ])('refuses an HTTP hook that %s', async (_what, status, body, problem) => {
    const url = await serverThat((_request, response) => response.writeHead(status).end(body));

    await expect(fireStop(httpHook(url))).rejects.toThrow(problem);
  });

  it('tells which events the settings configure hooks for', () => {
    const runner = commandHook('true');

    expect(runner.configures('Stop')).toBe(true);
    expect(runner.configures('MessageDisplay')).toBe(false);
  });
});
