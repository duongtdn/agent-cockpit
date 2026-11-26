import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

const appName = `host-machine-test-${process.pid}-${Date.now()}`;
let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-session-host-machine-'));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

let scripts = 0;

/** A program in tmux's place: a shell script that starts no server. */
function hostOn(script: string, timeoutMs?: number) {
  scripts += 1;
  const executable = join(folder, `tmux-${scripts}`);
  writeFileSync(executable, `#!/bin/sh\n${script}\n`);
  chmodSync(executable, 0o755);
  return createTmuxSessionHost({
    appName,
    executable,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** A tmux that finds the session live, and whose other commands are the script's. */
function hostWithSession(commands: string, timeoutMs?: number) {
  return hostOn(`case "$*" in\n*has-session*) exit 0 ;;\n${commands}\nesac`, timeoutMs);
}

const size = { columns: 80, rows: 24 };

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

describe('checking the machine', () => {
  it('passes on this machine’s tmux, and starts no server', async () => {
    const host = createTmuxSessionHost({ appName });

    await expect(host.checkMachine()).resolves.toBeUndefined();
  });

  it.each(['echo "tmux 3.2a"', 'echo "tmux 3.10"', 'echo "tmux next-3.6"'])(
    'passes when tmux says: %s',
    async (script) => {
      await expect(hostOn(script).checkMachine()).resolves.toBeUndefined();
    },
  );

  it('fails with unsupported-machine when tmux is not installed', async () => {
    const host = createTmuxSessionHost({ appName, executable: join(folder, 'no-tmux-here') });

    const error = await failureOf(host.checkMachine());

    expect(isCockpitError(error, 'unsupported-machine')).toBe(true);
    expect(error).toMatchObject({ what: 'tmux', found: 'none', required: '3.2a or later' });
  });

  it.each([
    ['echo "tmux 3.2"', '3.2'],
    ['echo "tmux 3.1c"', '3.1c'],
    ['echo "tmux next-3.2"', 'next-3.2'],
    ['echo "tmux master"', 'tmux master'],
  ])('fails with unsupported-machine when tmux says: %s', async (script, found) => {
    const error = await failureOf(hostOn(script).checkMachine());

    expect(isCockpitError(error, 'unsupported-machine')).toBe(true);
    expect(error).toMatchObject({ what: 'tmux', found, required: '3.2a or later' });
  });

  it('fails as the host’s own failure when tmux cannot tell its version', async () => {
    const error = await failureOf(hostOn('echo "broken build" >&2; exit 2').checkMachine());

    expect(error).toBeInstanceOf(SessionHostError);
    expect(error).toMatchObject({ reason: 'host-failed', message: 'tmux failed: broken build' });
  });
});

describe('a tmux that fails in a way the host does not know', () => {
  it('fails every operation as the host’s own failure, with what tmux said', async () => {
    const host = hostOn('echo "lost server" >&2; exit 1');

    const operations = [
      () => host.list(),
      () => host.isLive('s'),
      () => host.processOf('s'),
      () => host.kill('s'),
    ];

    for (const operation of operations) {
      const error = await failureOf(operation());

      expect(error).toBeInstanceOf(SessionHostError);
      expect(error).toMatchObject({ reason: 'host-failed', message: 'tmux failed: lost server' });
    }
  });

  it('fails as the host’s own failure when tmux says nothing, or nothing it should', async () => {
    expect(await failureOf(hostOn('exit 1').list())).toMatchObject({ reason: 'host-failed' });
    expect(await failureOf(hostOn('echo "not a pid"').processOf('s'))).toMatchObject({
      reason: 'host-failed',
    });
    expect(await failureOf(hostOn('echo "no screen"').readScreen('s'))).toMatchObject({
      reason: 'host-failed',
    });
    expect(await failureOf(hostOn('echo "no server line"').shutDown())).toMatchObject({
      reason: 'host-failed',
    });
  });
});

describe('a tmux that does not answer', () => {
  it('is ended after the time given, and the operation fails as the host’s own failure', async () => {
    const host = hostOn('exec sleep 30', 100);

    for (const operation of [() => host.list(), () => host.kill('s'), () => host.checkMachine()]) {
      expect(await failureOf(operation())).toMatchObject({
        reason: 'host-failed',
        message: 'tmux failed: no answer within 100 ms',
      });
    }
  });

  it('fails a start too, the commands never read', async () => {
    const host = hostOn('exec sleep 30', 100);

    const error = await failureOf(
      host.start({
        name: 's',
        folder,
        command: 'cat',
        args: [],
        environment: { set: {}, remove: [] },
        size,
      }),
    );

    expect(error).toMatchObject({ reason: 'host-failed' });
  });
});

describe('a start whose server cannot be reached', () => {
  it.each([
    'echo "no server running on /tmp/tmux-1000/app" >&2; exit 1',
    'echo "server exited unexpectedly" >&2; exit 1',
    'echo "error connecting to /tmp/tmux-1000/app (File name too long)" >&2; exit 1',
  ])(
    'fails as the host’s own failure, never as a session that does not live: %s',
    async (script) => {
      const error = await failureOf(
        hostOn(script).start({
          name: 's',
          folder,
          command: 'cat',
          args: [],
          environment: { set: {}, remove: [] },
          size,
        }),
      );

      expect(error).toBeInstanceOf(SessionHostError);
      expect(error).toMatchObject({ reason: 'host-failed' });
    },
  );
});

describe('a start on a machine without tmux', () => {
  it('fails as the host’s own failure', async () => {
    const host = createTmuxSessionHost({ appName, executable: 'cockpit-no-such-tmux' });

    const error = await failureOf(
      host.start({
        name: 's',
        folder,
        command: 'cat',
        args: [],
        environment: { set: {}, remove: [] },
        size,
      }),
    );

    expect(error).toBeInstanceOf(SessionHostError);
    expect(error).toMatchObject({ reason: 'host-failed' });
  });
});

describe('a terminal that does not get attached', () => {
  it('fails as the host’s own failure when its client exits first', async () => {
    const host = hostWithSession('*attach-session*) exit 0 ;;\n*list-clients*) exit 0 ;;');

    expect(await failureOf(host.attach('s', size))).toMatchObject({
      reason: 'host-failed',
      message: 'The terminal of s ended unattached.',
    });
  });

  it('fails with no-session when the session ends meanwhile', async () => {
    const host = hostWithSession(
      '*attach-session*) exec sleep 30 ;;\n*list-clients*) echo "can\'t find session: s" >&2; exit 1 ;;',
    );

    expect(await failureOf(host.attach('s', size))).toMatchObject({ reason: 'no-session' });
  });

  it('fails as the host’s own failure when tmux never lists it, and ends its client', async () => {
    const pidFile = join(folder, 'client.pid');
    const host = hostWithSession(
      `*attach-session*) echo $$ > "${pidFile}"; exec sleep 30 ;;\n*list-clients*) echo 1 ;;`,
      200,
    );

    expect(await failureOf(host.attach('s', size))).toMatchObject({
      reason: 'host-failed',
      message: 'tmux did not attach a terminal to s within 200 ms.',
    });
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
  });
});

describe('shutting down a server that is exiting', () => {
  it.each([
    [
      'refuses the connection',
      'echo "error connecting to $SOCKET (Connection refused)" >&2; exit 1',
    ],
    [
      'exits under the call, then is gone',
      'if [ -e "$SOCKET.asked" ]; then echo "no server running on $SOCKET" >&2; else touch "$SOCKET.asked"; echo "server exited unexpectedly" >&2; fi; exit 1',
    ],
  ])('removes the socket it left when it %s', async (_how, script) => {
    const socket = join(folder, `left-${scripts}`);
    writeFileSync(socket, '');
    const host = hostOn(`SOCKET='${socket}'\n${script}`);

    await host.shutDown();

    expect(existsSync(socket)).toBe(false);
    rmSync(`${socket}.asked`, { force: true });
  });
});
