import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { AsksClosedError } from '../../src/server/asks/asks.ts';
import { type Cockpit, createCockpit, type Job } from '../../src/server/index.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import type { Ask, AskSettled } from '../../src/shared/ask.ts';
import { writeAgentShim } from '../support/agent-shim.ts';
import { eventually } from '../support/eventually.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import {
  type AskedCall,
  answerInTerminal,
  type TerminalAnswer,
  writeScript,
} from '../support/fake-agent/script.ts';
import { startNodeHttpApp } from '../support/node-http-app.ts';
import { openedSocket, openSocket, post } from '../support/wire-client.ts';

/**
 * What only a cockpit assembled by `createCockpit` shows of the asks: the
 * agent's permission, asked through its real hook to the real listener, is
 * the ask `cockpit.asks` and the wire give the app, and the answer the app
 * or the person gives reaches the agent. The decisions are the unit tests'.
 */

const explain = {
  id: 'explain',
  title: 'Explain a file',
  args: z.object({ file: z.string().min(1) }),
  key: ({ file }: { file: string }) => `explain-${file}`,
  prompt: ({ file }: { file: string }) => `Explain ${file}`,
} satisfies Job<z.ZodObject<{ file: z.ZodString }>>;

const KEY = 'explain-a';

/** The call the agent asks for: a tool and an input the contract suite recorded asked. */
const CALL: AskedCall = {
  tool: 'Bash',
  input: { command: 'touch b.txt', description: 'Create b.txt' },
};

let root: string;
let made = 0;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-asks-')));
  const shims = join(root, 'bin');
  mkdirSync(shims);
  writeAgentShim(shims, fakeAgentCommand());
  // The driver launches `claude` from the server's PATH, and reads the
  // conversations where the agents it launched keep them.
  vi.stubEnv('PATH', `${shims}:${process.env.PATH}`);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** An app's cockpit, mounted on a `node:http` server of its own. */
interface Started {
  readonly cockpit: Cockpit;
  readonly token: string;
  /** The app's folder, where the fake agent reads its script. */
  readonly directory: string;
  /** The mount's base URL. */
  readonly base: string;
}

/** A cockpit of an app of its own, mounted; closed, its tmux server with it, after the test. */
async function started(): Promise<Started> {
  made += 1;
  const name = `asks-${process.pid}-${made}`;
  const directory = join(root, `work-${made}`);
  mkdirSync(directory);
  const app = await startNodeHttpApp('127.0.0.1');
  cleanups.push(() => app.close());
  const cockpit = await createCockpit({
    name,
    directory,
    driver: claudeCode(),
    jobs: [explain as unknown as Job],
    stateDirectory: join(root, `state-${made}`),
    port: app.port,
  });
  cleanups.push(async () => {
    await cockpit.close();
    await createTmuxSessionHost({ appName: name }).shutDown();
  });
  app.serve(cockpit);
  const token = new URL(cockpit.link('http://127.0.0.1:8765/')).hash.replace('#cockpit=', '');
  return { cockpit, token, directory, base: app.base };
}

/** Runs the job on a turn that asks for {@link CALL}, and gives the ask once it is pending. */
async function asking({ cockpit, directory }: Started): Promise<Ask> {
  writeScript(directory, [{ do: 'turn', reply: 'Made b.txt.', asks: [CALL] }]);
  const opened = new Promise<Ask>((resolve) => cockpit.asks.follow(KEY, resolve));
  await cockpit.run('explain', { file: 'a' });
  return opened;
}

/** The first settlement the cockpit tells. */
function settlement(cockpit: Cockpit): Promise<AskSettled> {
  return new Promise((resolve) => cockpit.asks.on('settled', resolve));
}

/** The states the key's session went through, each once, in order, from now on. */
function statesOf(cockpit: Cockpit): string[] {
  const states: string[] = [];
  cockpit.sessions.follow((sessions) => {
    const state = sessions.find((session) => session.key === KEY)?.state;
    if (state !== undefined && states.at(-1) !== state) states.push(state);
  });
  return states;
}

const ws = (base: string, path: string) => `${base.replace(/^http/, 'ws')}${path}`;

describe("the agent's permission, through the assembled cockpit", () => {
  it('is an ask the app answers: the session waiting while it is pending, then busy and idle once allowed, the settled handlers told', async () => {
    const start = await started();
    const { cockpit } = start;
    const states = statesOf(cockpit);
    const settled = settlement(cockpit);

    const ask = await asking(start);

    expect(ask).toMatchObject({ key: KEY, kind: 'permission', tool: 'Bash', answerable: 'app' });
    expect(cockpit.sessions.list()).toMatchObject([
      { key: KEY, state: 'waiting', pending: [{ kind: 'ask', id: ask.id }] },
    ]);
    await cockpit.asks.answer(ask.id, { allow: true });
    expect(await settled).toEqual({ id: ask.id, key: KEY, by: 'app' });
    await eventually(() => expect(states.at(-1)).toBe('idle'));
    expect(states).toEqual(['starting', 'busy', 'waiting', 'busy', 'idle']);
    expect(cockpit.sessions.list()).toMatchObject([{ lastMessage: 'Made b.txt.' }]);
  });

  it.each<[TerminalAnswer, AskSettled['by']]>([
    ['esc', 'cancelled'],
    ['yes', 'terminal'],
    ['amended-no', 'terminal'],
  ])('is settled by the person’s %s in the terminal: %s', async (answer, by) => {
    const start = await started();
    const settled = settlement(start.cockpit);
    const ask = await asking(start);

    answerInTerminal(start.directory, answer);

    expect(await settled).toEqual({ id: ask.id, key: KEY, by });
  });

  it("reaches the app's error handlers with what a follower or a settled handler threw", async () => {
    const start = await started();
    const { cockpit } = start;
    const failures: unknown[] = [];
    cockpit.on('error', (error) => failures.push(error));
    const followerBroke = new Error('the follower broke');
    const handlerBroke = new Error('the settled handler broke');
    cockpit.asks.follow(KEY, () => {
      throw followerBroke;
    });
    cockpit.asks.on('settled', () => {
      throw handlerBroke;
    });
    const ask = await asking(start);

    await cockpit.asks.answer(ask.id, { allow: true });

    expect(failures).toEqual([
      expect.objectContaining({ code: 'internal-failure', where: 'asks', cause: followerBroke }),
      expect.objectContaining({ code: 'internal-failure', where: 'asks', cause: handlerBroke }),
    ]);
  });

  it('is let go as the cockpit closes: the held hook dropped, nobody told, a later answer refused', async () => {
    const start = await started();
    const { cockpit } = start;
    const ask = await asking(start);
    const told: AskSettled[] = [];
    cockpit.asks.on('settled', (settled) => told.push(settled));

    // The listener waits for no held connection: the close ends with the hook still unanswered.
    await cockpit.close();

    await expect(cockpit.asks.answer(ask.id, { allow: true })).rejects.toThrow(AsksClosedError);
    expect(told).toEqual([]);
  });

  it('is followed and answered over the wire, the token checked on both paths', async () => {
    const start = await started();
    const { token, base } = start;
    const ask = await asking(start);

    const unfollowed = await openSocket(ws(base, `/follow/asks?key=${KEY}`));
    const follower = await openedSocket(ws(base, `/follow/asks?key=${KEY}`), { token });
    const first = JSON.parse(String(await follower.next(() => true)));
    const unanswered = await post(`${base}/asks/answer`, { id: ask.id, answer: { allow: true } });
    const answered = await post(
      `${base}/asks/answer`,
      { id: ask.id, answer: { allow: true } },
      { token },
    );
    const settled = await follower.next(
      (message) => (JSON.parse(String(message)) as { type: string }).type === 'settled',
    );

    expect(unfollowed).toMatchObject({ refused: { status: 401 } });
    expect(first).toEqual({ type: 'asks', pending: [ask], settled: [] });
    expect(unanswered.status).toBe(401);
    expect(answered.status).toBe(204);
    expect(JSON.parse(String(settled))).toEqual({
      type: 'settled',
      id: ask.id,
      key: KEY,
      by: 'app',
    });
    follower.socket.close();
  });
});
