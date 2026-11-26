import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { createSessions, type Sessions } from '../../src/server/sessions/sessions.ts';
import type { Session } from '../../src/shared/session.ts';
import { eventually } from '../support/eventually.ts';
import { type Turn, writeScript } from '../support/fake-agent/script.ts';
import {
  fakeAgentDriver,
  type HookForwarder,
  startHookForwarder,
} from '../support/fake-agent-driver.ts';

const appName = `sessions-test-${process.pid}-${Date.now()}`;
const pacing = { chunkLength: 100, pauseMs: 1 };

let host: SessionHost;
let root: string;
let forwarder: HookForwarder;
let sessions: Sessions;
let directory: string;
let works = 0;

beforeAll(() => {
  host = createTmuxSessionHost({ appName });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-sessions-')));
});

beforeEach(async () => {
  works += 1;
  directory = join(root, `work-${works}`);
  mkdirSync(directory);
  forwarder = await startHookForwarder((request) => sessions.receive(request));
  sessions = createSessions({
    host,
    driver: fakeAgentDriver(join(root, 'config')),
    hooks: forwarder,
    folders: {
      async prepare(key) {
        const folder = join(root, 'state', `${works}`, key);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        return folder;
      },
    },
    environment: () => ({ PATH: process.env.PATH ?? '' }),
  });
});

afterEach(async () => {
  sessions.close();
  for (const name of await host.list()) await host.kill(name);
  await forwarder.close();
});

afterAll(async () => {
  await host.shutDown();
  rmSync(root, { recursive: true, force: true });
});

function run(key: string, script: readonly Turn[], prompt = 'Explain README.md') {
  writeScript(directory, script);
  return sessions.run({ key, directory, prompt });
}

function stateOf(key: string): Session | undefined {
  return sessions.list().find((session) => session.key === key);
}

/** Waits until the session is in the state, and gives it. */
function inState<S extends Session['state']>(key: string, state: S) {
  return eventually(() => {
    const session = stateOf(key);
    expect(session?.state).toBe(state);
    return session as Extract<Session, { state: S }>;
  });
}

describe('the sessions core, with the fake agent in tmux', () => {
  it('runs a job: `starting`, then `busy` when the prompt is taken, `idle` with the answer, `ended` when the agent exits on a prompt', async () => {
    const seen: string[] = [];
    sessions.follow((list) => {
      const state = list[0]?.state;
      if (state !== undefined && seen.at(-1) !== state) seen.push(state);
    });

    const result = await run('explain-readme', [
      [{ do: 'reply', text: 'Done.' }],
      [{ do: 'exit' }],
    ]);

    expect(result).toEqual({ action: 'started', state: 'busy' });
    expect(await inState('explain-readme', 'idle')).toMatchObject({ lastMessage: 'Done.' });

    await host.sendText('explain-readme', 'bye', pacing);
    await host.sendKeys('explain-readme', ['Enter']);

    expect(await inState('explain-readme', 'ended')).toMatchObject({
      reason: 'agent-exit',
      canResume: true,
    });
    // The prompt that makes it exit is a turn too.
    expect(seen).toEqual(['starting', 'busy', 'idle', 'busy', 'ended']);
  });

  it('sees a session killed with no word from its agent as `lost`', async () => {
    await run('killed', [[{ do: 'stay-busy' }]]);

    await host.kill('killed');

    expect(await inState('killed', 'ended')).toMatchObject({ reason: 'lost', canResume: true });
  });

  it('refuses a key whose session an earlier run left on the socket', async () => {
    await host.start({
      name: 'left-over',
      folder: directory,
      command: 'sleep',
      args: ['60'],
      environment: { set: {}, remove: [] },
      size: { columns: 80, rows: 24 },
    });

    await expect(run('left-over', [[{ do: 'reply', text: 'Done.' }]])).rejects.toMatchObject({
      reason: 'session-exists',
    });
    expect(sessions.list()).toEqual([]);
  });

  it("tells a session's end through its attached terminal", async () => {
    await run('attached', [[{ do: 'stay-busy' }]]);
    const attachment = await sessions.attach('attached', { columns: 80, rows: 24 });
    expect(attachment).toBeDefined();
    const ended = new Promise<void>((resolve) => attachment?.onEnd(resolve));

    await host.kill('attached');
    await ended;

    expect(await inState('attached', 'ended')).toMatchObject({ reason: 'lost' });
  });
});
