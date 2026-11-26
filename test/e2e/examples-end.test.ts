import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
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
