import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_PATH, TOKEN_HEADER } from '../../src/shared/wire.ts';
import { eventually } from '../support/eventually.ts';
import {
  type ExampleApp,
  interruptExampleWhileStarting,
  runExampleToItsEnd,
  startExampleApp,
} from '../support/example-app.ts';

/**
 * However an example ends, its scripted agent leaves nothing behind: its
 * temporary folder (and the tmux socket, the agent's files in it) is gone.
 */

const EXAMPLES = ['jobs-console', 'translate-and-access'] as const;

let app: ExampleApp | undefined;
let taken: Server | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
  await new Promise<void>((resolve) => (taken ? taken.close(() => resolve()) : resolve()));
  taken = undefined;
});

/** The folder an example said its scripted agent keeps everything in. */
function named(root: string | undefined, printed: string): string {
  if (root === undefined) throw new Error(`The example named no folder:\n${printed}`);
  return root;
}

/** A loopback port something else listens on. */
async function takenPort(): Promise<number> {
  taken = createServer();
  await new Promise<void>((resolve) => taken?.listen(0, '127.0.0.1', resolve));
  return (taken.address() as AddressInfo).port;
}

describe.each(EXAMPLES)('%s, as it ends', (example) => {
  it('removes what it started when it cannot start: its port is taken', async () => {
    const ended = await runExampleToItsEnd(example, ['--port', String(await takenPort())]);

    expect(ended.code, ended.printed).not.toBe(0);
    expect(ended.printed).toContain('EADDRINUSE');
    expect(
      existsSync(named(ended.temporaryRoot, ended.printed)),
      'its temporary folder is removed',
    ).toBe(false);
  });

  it('stops as on Ctrl+C when its terminal closes (SIGHUP)', async () => {
    app = await startExampleApp(example, ['--port', '0']);
    const root = named(app.temporaryRoot(), app.printed());

    const exitCode = await app.stop('SIGHUP');

    expect(exitCode, app.printed()).toBe(0);
    expect(app.printed()).toContain('Stopped.');
    expect(existsSync(root), 'its temporary folder is removed').toBe(false);
  });

  it.each(['SIGINT', 'SIGHUP'] as const)(
    'removes what it started when stopped while it starts (%s)',
    async (signal) => {
      const ended = await interruptExampleWhileStarting(example, ['--port', '0'], signal);

      expect(ended.code, ended.printed).toBe(0);
      expect(ended.printed).toContain('Stopped.');
      expect(
        existsSync(named(ended.temporaryRoot, ended.printed)),
        'its temporary folder is removed',
      ).toBe(false);
    },
  );
});

describe('translate-and-access, refusing what it cannot do', () => {
  it('starts nothing with --open on a port chosen when it listens', async () => {
    const ended = await runExampleToItsEnd('translate-and-access', ['--open', '--port', '0']);

    expect(ended.code, ended.printed).toBe(2);
    expect(ended.printed).toContain('--open needs a fixed --port');
    expect(ended.temporaryRoot, 'no scripted agent was started').toBeUndefined();
  });
});

describe('translate-and-access, stopped twice', () => {
  let held: Socket | undefined;

  afterEach(() => {
    held?.destroy();
    held = undefined;
  });

  it('forces the exit on a second Ctrl+C while its stop hangs, removing what its scripted agent started', async () => {
    app = await startExampleApp('translate-and-access', ['--port', '0']);
    const root = named(app.temporaryRoot(), app.printed());
    const link = new URL(app.link);
    await runHello(link);
    const tmuxServer = tmuxServerOf(root);
    // A request whose body never comes: the server's close waits for it.
    held = await requestNeverEnding(link);

    app.signal('SIGINT');
    await app.nextLine(/^Stopping/);
    const exitCode = await app.stop('SIGINT');

    expect(exitCode, app.printed()).toBe(1);
    expect(app.printed()).toContain('Forced to stop');
    await eventually(() => expect(isRunning(tmuxServer), 'its tmux server is ended').toBe(false));
    expect(existsSync(root), 'its temporary folder is removed').toBe(false);
  });
});

/** Runs the example's job, so that its scripted agent has a tmux server. */
async function runHello(link: URL): Promise<void> {
  const answer = await fetch(`${link.origin}/cockpit${RUN_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TOKEN_HEADER]: link.hash.replace('#cockpit=', ''),
    },
    body: JSON.stringify({ jobId: 'hello', args: { name: 'Ada' } }),
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
}

/** The process of the tmux server the scripted agent keeps under its root. */
function tmuxServerOf(root: string): number {
  const socket = join(root, 'tmux', `tmux-${userInfo().uid}`, 'agent-cockpit-translate-and-access');
  return Number(
    execFileSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }),
  );
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sends the app a request's head, announcing a body it never sends. */
async function requestNeverEnding(link: URL): Promise<Socket> {
  const socket = connect(Number(link.port), link.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(
    `POST /api/sign-in HTTP/1.1\r\nHost: ${link.host}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{`,
  );
  return socket;
}
