import { randomUUID } from 'node:crypto';
import { onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import type { Driver, HookRequest, LaunchCommand } from '../../src/server/driver.ts';
import { type Cockpit, createCockpit, type Job } from '../../src/server/index.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import type { Session, SessionState } from '../../src/shared/session.ts';
import { type AgentSession, sessionOf } from '../support/agent-session.ts';
import { type FakeApi, startFakeApi } from '../support/fake-api/index.ts';
import { agentFoldersOutside, tearDownRun } from '../support/real-agent/run-root.ts';
import { type RealAgentShim, startRealAgentShim } from '../support/real-agent/shim.ts';
import { runAll } from '../support/run-all.ts';
import { assertNoUnexpectedPath, inputBoxText } from './harness.ts';

/**
 * A cockpit as an app makes one, with the Claude Code driver, running the
 * pinned agent against the scripted API: the driver's own launch, settings
 * and hooks, the core's own listener and its token checks. Only `claude`
 * on the server's `PATH` is the test's (a shim that runs the pinned binary
 * with the recipe's variables), and every launch passes the real-agent
 * guard before the cockpit starts it.
 */
export interface ContractCockpit {
  /** The scripted double of the API the agent talks to. */
  readonly api: FakeApi;
  /** The cockpit. */
  readonly cockpit: Cockpit;
  /** The folder the sessions work in: the cockpit's `directory`. */
  readonly workFolder: string;
  /**
   * Every hook request the driver was given to read, in order of arrival.
   * The listener gives the driver only a request that carried the
   * session's token in its `Authorization` header.
   */
  readonly hooksRead: readonly HookRequest[];
  /** Every command the driver gave the cockpit to launch. */
  readonly launches: readonly LaunchCommand[];
  /**
   * Runs the job {@link SAY}: one session, of the key {@link SAID_KEY}, on the prompt given.
   *
   * @returns What the cockpit's run resolved with.
   */
  say(prompt: string): ReturnType<Cockpit['run']>;
  /** The states the session of a key went through, each once, in order, as the cockpit's following told them. */
  states(key: string): SessionState[];
  /**
   * Waits until the session of a key is in a state.
   *
   * @returns The session as listed then.
   * @throws Error when it takes too long, or the agent sent a request the test scripted no answer for.
   */
  sessionIn(key: string, state: SessionState): Promise<Session>;
  /**
   * Gives the terminal of a session, to type into and read, as a person at
   * the mounted terminal would.
   *
   * @param key - The session's key.
   * @param conversationId - Its conversation's id, where its transcript is read.
   */
  terminal(key: string, conversationId: string): AgentSession;
  /**
   * Ends a session as a person does in its terminal: `/exit`, submitted as
   * the driver submits, Enter again while it stays in the input box.
   *
   * @returns The session, `ended`.
   */
  exitByItself(key: string, conversationId: string): Promise<Session>;
}

/** The job every test runs: the prompt as it is given, on one key. */
export const SAID_KEY = 'say';

const SAY = {
  id: 'say',
  title: 'Say something',
  args: z.object({ prompt: z.string() }),
  key: () => SAID_KEY,
  prompt: ({ prompt }: { prompt: string }) => prompt,
} satisfies Job<z.ZodObject<{ prompt: z.ZodString }>>;

/** Far longer than the agent takes, short enough to fail with the reason. */
const PATIENCE_MS = 15_000;
/** How long an Enter on `/exit` is given before it is pressed again, as {@link submitInputBox} gives one. */
const EXIT_PATIENCE_MS = 3000;
const ENTER_PRESSES = 3;

/**
 * Starts a cockpit with the Claude Code driver for the running test, and
 * ends it when the test finishes, passed or failed: the cockpit, its tmux
 * server, the agents' processes, the temporary root, the server's
 * variables the test changed, the API's double — each of them, whatever the
 * others did. The test then fails if the agent sent a request nothing
 * scripted, or left something outside its root.
 *
 * @param permissions - The permission rules the driver writes in each session's settings.
 */
export async function startContractCockpit(permissions?: {
  readonly allow?: readonly string[];
}): Promise<ContractCockpit> {
  const closers: (() => Promise<void>)[] = [];
  const finalChecks: (() => void)[] = [];
  onTestFinished(() => runAll([...closers.reverse(), ...finalChecks]));
  const api = await startFakeApi();
  closers.push(() => api.close());
  finalChecks.push(
    () => api.assertNothingUnexpected(),
    () => assertNoUnexpectedPath(api),
  );
  const shim = await startRealAgentShim(api.baseUrl);
  finalChecks.push(() => {
    const left = agentFoldersOutside(shim.root);
    if (left.length > 0)
      throw new Error(`The agent left folders outside its root: ${left.join(', ')}`);
  });
  closers.push(async () => void vi.unstubAllEnvs());
  serveFrom(shim);

  const hooksRead: HookRequest[] = [];
  const launches: LaunchCommand[] = [];
  const name = `contract-cockpit-${randomUUID()}`;
  const host = createTmuxSessionHost({ appName: name });
  const processIds: number[] = [];
  const cockpit = await createCockpit({
    name,
    directory: shim.workFolder,
    driver: recorded(shim.guarded(claudeCode(permissions ? { permissions } : undefined)), {
      hooksRead,
      launches,
    }),
    jobs: [SAY],
    stateDirectory: shim.stateFolder,
  });
  closers.push(() =>
    tearDownRun({
      endSessions: async () => {
        try {
          await cockpit.close();
        } finally {
          await host.shutDown();
        }
      },
      processIds,
      root: shim.root,
    }),
  );
  const following = followed(cockpit, api);
  closers.push(async () => following.stop());

  const terminal = (key: string, conversationId: string) =>
    sessionOf(host, { name: key, id: conversationId, configFolder: shim.configFolder });

  return {
    api,
    cockpit,
    workFolder: shim.workFolder,
    hooksRead,
    launches,
    async say(prompt) {
      const result = await cockpit.run(SAY.id, { prompt });
      // Remembered for the teardown, which waits for the agent to exit.
      const running = await host.processOf(SAID_KEY);
      if (running !== undefined) processIds.push(running.pid);
      return result;
    },
    states: following.states,
    sessionIn: following.sessionIn,
    terminal,
    async exitByItself(key, conversationId) {
      const session = terminal(key, conversationId);
      await session.type('/exit');
      for (let enters = 1; ; enters++) {
        await session.press('Enter');
        const ended = await following
          .sessionIn(key, 'ended', EXIT_PATIENCE_MS)
          .catch(() => undefined);
        if (ended !== undefined) return ended;
        const box = inputBoxText(await session.screen().catch(() => ''));
        if (box === undefined || !box.includes('/exit') || enters === ENTER_PRESSES) {
          return following.sessionIn(key, 'ended');
        }
      }
    },
  };
}

/** Gives the server's process the shim's variables, for the test: the driver reads them there. */
function serveFrom(shim: RealAgentShim): void {
  for (const [name, value] of Object.entries(shim.serverVariables)) vi.stubEnv(name, value);
}

/** What a recorded driver keeps. */
interface DriverRecord {
  readonly hooksRead: HookRequest[];
  readonly launches: LaunchCommand[];
}

/** Gives a driver that keeps what it launched and every hook it read; nothing of it changes. */
function recorded(driver: Driver, record: DriverRecord): Driver {
  return {
    ...driver,
    async launch(launch) {
      const command = await driver.launch(launch);
      record.launches.push(command);
      return command;
    },
    readHook(request) {
      record.hooksRead.push(request);
      return driver.readHook(request);
    },
  };
}

interface Following {
  states(key: string): SessionState[];
  sessionIn(key: string, state: SessionState, patienceMs?: number): Promise<Session>;
  stop(): void;
}

/** Follows the cockpit's sessions from now on, keeping each key's states. */
function followed(cockpit: Cockpit, api: FakeApi): Following {
  const seen = new Map<string, Session[]>();
  const waiters = new Set<() => void>();
  const stop = cockpit.sessions.follow((sessions) => {
    for (const session of sessions) {
      const history = seen.get(session.key) ?? [];
      if (history.at(-1)?.state !== session.state) seen.set(session.key, [...history, session]);
    }
    for (const waiter of waiters) waiter();
  });

  function sessionIn(key: string, state: SessionState, patienceMs = PATIENCE_MS): Promise<Session> {
    const found = () => seen.get(key)?.find((session) => session.state === state);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(check);
      };
      const check = () => {
        const session = found();
        if (session === undefined) return;
        done();
        resolve(session);
      };
      const timer = setTimeout(() => {
        done();
        const states = (seen.get(key) ?? []).map((session) => session.state);
        reject(
          new Error(
            `Waited ${patienceMs} ms for the session ${key} to be ${state}; it went through: ${states.join(', ') || 'nothing'}.`,
          ),
        );
      }, patienceMs);
      void api.unexpectedRequest().then((failure) => {
        done();
        reject(failure);
      });
      waiters.add(check);
      check();
    });
  }

  return {
    states: (key) => (seen.get(key) ?? []).map((session) => session.state),
    sessionIn,
    stop,
  };
}
