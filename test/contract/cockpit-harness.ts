import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { type ClaudeCodeOptions, claudeCode } from '../../src/claude-code/index.ts';
import type {
  Conversation,
  Driver,
  DriverEvent,
  HookRequest,
  LaunchCommand,
} from '../../src/server/driver.ts';
import { type Cockpit, createCockpit, type Job } from '../../src/server/index.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import type { Session, SessionState } from '../../src/shared/session.ts';
import { type AgentSession, sessionOf } from '../support/agent-session.ts';
import { type FakeApi, startFakeApi } from '../support/fake-api/index.ts';
import { startNodeHttpApp } from '../support/node-http-app.ts';
import { agentFoldersOutside, tearDownRun } from '../support/real-agent/run-root.ts';
import {
  type RealAgentShim,
  type RealAgentShimOptions,
  startRealAgentShim,
} from '../support/real-agent/shim.ts';
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
  /** The run's temporary root, which holds the other folders. */
  readonly root: string;
  /** The agent's configuration folder, where the person's own settings are. */
  readonly configFolder: string;
  /** The `PATH` of the server's process: the shim's folder first, so that `claude` is the shim. */
  readonly serverPath: string;
  /** The cockpit's state folder, the app's `stateDirectory`: a state root no session may reach. */
  readonly stateFolder: string;
  /** The agent's `HOME`, where the person's own files are. */
  readonly home: string;
  /** The port of the app's browser-facing server, which the cockpit denies every session's sandbox. */
  readonly appPort: number;
  /**
   * Every hook request the driver was given to read, in order of arrival.
   * The listener gives the driver only a request that carried the
   * session's token in its `Authorization` header.
   */
  readonly hooksRead: readonly HookRequest[];
  /** Every command the driver gave the cockpit to launch. */
  readonly launches: readonly LaunchCommand[];
  /** Every conversation the cockpit had the driver follow, in order. */
  readonly conversationsFollowed: readonly Conversation[];
  /** Every conversation the cockpit asked the driver whether it can resume, in order. */
  readonly askedToResume: readonly Conversation[];
  /**
   * What the cockpit saw of its sessions, in order: each hook the driver
   * was given to read, and each session as it changed state.
   */
  readonly timeline: readonly Moment[];
  /**
   * Runs the job {@link SAY}: one session, of the key given, on the prompt given.
   *
   * @param key - The session's key; {@link SAID_KEY} by default.
   * @returns What the cockpit's run resolved with.
   */
  say(prompt: string, key?: string): ReturnType<Cockpit['run']>;
  /**
   * Gives the conversation a session of a key was last launched with.
   *
   * @throws Error when no session of the key was launched.
   */
  conversationOf(key: string): string;
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
  terminal(key: string, conversationId?: string): AgentSession;
  /**
   * Submits a text typed into a session's terminal as a person and the
   * driver do: Enter, a few seconds for the hook that confirms it, Enter
   * again while the text stays in the input box, up to three times.
   *
   * @param confirmation - The hook that tells the text was taken: `UserPromptSubmit` by default.
   * @returns The hook's payload.
   * @throws Error when the box still holds the text after the last Enter.
   */
  submitInTerminal(key: string, text: string, confirmation?: string): Promise<HookPayload>;
  /**
   * Submits the text a session's input box holds already, as
   * {@link submitInTerminal} does once it typed it.
   *
   * @param text - What the box holds.
   */
  submitInputBoxInTerminal(key: string, text: string, confirmation?: string): Promise<HookPayload>;
  /**
   * Ends a session as a person does in its terminal: `/exit`, submitted as
   * the driver submits, Enter again while it stays in the input box.
   *
   * @returns The session, `ended`.
   */
  exitByItself(key: string, conversationId: string): Promise<Session>;
}

/** A hook's payload, as the driver read it. */
export type HookPayload = Record<string, unknown>;

/**
 * One thing the cockpit saw of its sessions: a hook read, what the driver
 * told outside the hooks of a conversation it follows, or a session's new
 * state.
 */
export type Moment =
  | { readonly hook: HookPayload }
  | { readonly told: readonly DriverEvent[] }
  | { readonly session: Session };

/** The key of a session the job {@link SAY} runs when the test names none. */
export const SAID_KEY = 'say';

const sayArgs = z.object({ prompt: z.string(), key: z.string() });

/** The job every test runs: the prompt as it is given, on the key given. */
const SAY = {
  id: 'say',
  title: 'Say something',
  args: sayArgs,
  key: ({ key }: z.output<typeof sayArgs>) => key,
  prompt: ({ prompt }: z.output<typeof sayArgs>) => prompt,
} satisfies Job<typeof sayArgs>;

/** Far longer than the agent takes, short enough to fail with the reason. */
const PATIENCE_MS = 15_000;
/** How long an Enter on `/exit` is given before it is pressed again, as {@link submitInputBox} gives one. */
const EXIT_PATIENCE_MS = 3000;
const ENTER_PRESSES = 3;

/** The run's folders, for a test that builds its options from them. */
export type CockpitFolders = Pick<RealAgentShim, 'root' | 'home' | 'configFolder' | 'workFolder'>;

/** What a test chooses of the cockpit it starts. */
export interface ContractCockpitOptions {
  /**
   * The driver's options, as an app gives them, or built from the run's
   * folders (a plugin's folder among them): none by default.
   */
  readonly driver?: ClaudeCodeOptions | ((folders: CockpitFolders) => ClaudeCodeOptions);
  /**
   * The folder the cockpit's sessions work in, its `directory`, made by the
   * test from the run's folders: the work folder, trusted in the agent's
   * configuration, by default.
   */
  readonly directory?: (folders: CockpitFolders) => string;
  /**
   * What the shim is made with: the pieces of the recipe left out, the
   * variables it gives the agent, those it passes on from the launch.
   */
  readonly shim?: RealAgentShimOptions;
  /**
   * The person's own settings (the user's `settings.json` of the agent's
   * configuration folder), which the agent reads beside the driver's and
   * the guard checks as it checks them: none by default.
   */
  readonly personsSettings?: Readonly<Record<string, unknown>>;
  /**
   * The address the app's server listens on: `127.0.0.1` by default; `::`
   * for every address of the machine, both families, where a sandboxed
   * command could reach it by any of them were it not denied.
   */
  readonly appAddress?: string;
}

/**
 * The person's own settings that turn the sandbox on, as a person does (the
 * driver never turns it on): a command it cannot run in fails, never runs
 * unconfined.
 */
export const PERSONS_SANDBOX = { sandbox: { enabled: true, failIfUnavailable: true } };

/**
 * The person's own acceptance of the warning a session in
 * `bypassPermissions` opens with, given once as a person does.
 */
export const BYPASS_ACCEPTED = { skipDangerousModePermissionPrompt: true };

/**
 * Starts a cockpit with the Claude Code driver for the running test, and
 * ends it when the test finishes, passed or failed: the cockpit, its tmux
 * server, the agents' processes, the temporary root, the server's
 * variables the test changed, the API's double — each of them, whatever the
 * others did. The test then fails if the agent sent a request nothing
 * scripted, or left something outside its root.
 *
 * @param options - See {@link ContractCockpitOptions}.
 */
export async function startContractCockpit(
  options: ContractCockpitOptions = {},
): Promise<ContractCockpit> {
  const closers: (() => Promise<void>)[] = [];
  const finalChecks: (() => void)[] = [];
  onTestFinished(() => runAll([...closers.reverse(), ...finalChecks]));
  const api = await startFakeApi();
  closers.push(() => api.close());
  finalChecks.push(
    () => api.assertNothingUnexpected(),
    () => assertNoUnexpectedPath(api),
  );
  const shim = await startRealAgentShim(api.baseUrl, options.shim);
  finalChecks.push(() => {
    const left = agentFoldersOutside(shim.root);
    if (left.length > 0)
      throw new Error(`The agent left folders outside its root: ${left.join(', ')}`);
  });
  closers.push(async () => void vi.unstubAllEnvs());
  serveFrom(shim);
  if (options.personsSettings !== undefined) {
    writeFileSync(
      join(shim.configFolder, 'settings.json'),
      JSON.stringify(options.personsSettings),
    );
  }

  const hooksRead: HookRequest[] = [];
  const launches: LaunchCommand[] = [];
  const conversationsFollowed: Conversation[] = [];
  const askedToResume: Conversation[] = [];
  const conversations = new Map<string, string>();
  const timeline: Moment[] = [];
  const name = `contract-cockpit-${randomUUID()}`;
  const host = createTmuxSessionHost({ appName: name });
  const processIds: number[] = [];
  // The app's browser-facing server, on the neutral handler: it listens
  // first, then gives the cockpit its port, as an app does.
  const app = await startNodeHttpApp(options.appAddress ?? '127.0.0.1');
  closers.push(() => app.close());
  const driverOptions =
    typeof options.driver === 'function' ? options.driver(shim) : options.driver;
  const directory = options.directory?.(shim) ?? shim.workFolder;
  const cockpit = await createCockpit({
    name,
    directory,
    driver: recorded(shim.guarded(claudeCode(driverOptions)), {
      hooksRead,
      launches,
      conversationsFollowed,
      askedToResume,
      conversations,
      timeline,
    }),
    jobs: [SAY],
    stateDirectory: shim.stateFolder,
    port: app.port,
  });
  app.serve(cockpit);
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
  const following = followed(cockpit, api, timeline);
  closers.push(async () => following.stop());

  const conversationOf = (key: string) => {
    const conversation = conversations.get(key);
    if (conversation === undefined) throw new Error(`No session of the key ${key} was launched.`);
    return conversation;
  };
  const terminal = (key: string, conversationId = conversationOf(key)) =>
    sessionOf(host, { name: key, id: conversationId, configFolder: shim.configFolder });

  return {
    api,
    cockpit,
    workFolder: directory,
    root: shim.root,
    configFolder: shim.configFolder,
    serverPath: shim.serverVariables.PATH as string,
    stateFolder: shim.stateFolder,
    home: shim.home,
    appPort: app.port,
    hooksRead,
    launches,
    conversationsFollowed,
    askedToResume,
    timeline,
    async say(prompt, key = SAID_KEY) {
      try {
        return await cockpit.run(SAY.id, { prompt, key });
      } finally {
        // Remembered for the teardown, which waits for the agent to exit.
        const running = await host.processOf(key).catch(() => undefined);
        if (running !== undefined) processIds.push(running.pid);
      }
    },
    conversationOf,
    states: following.states,
    sessionIn: following.sessionIn,
    terminal,
    async submitInTerminal(key, text, confirmation = 'UserPromptSubmit') {
      const session = terminal(key);
      await session.type(text);
      return submittedInTerminal({ session, hooksRead, text, confirmation, api });
    },
    submitInputBoxInTerminal: (key, text, confirmation = 'UserPromptSubmit') =>
      submittedInTerminal({ session: terminal(key), hooksRead, text, confirmation, api }),
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

/**
 * Waits until a session of the cockpit is in a state, at a moment of its
 * timeline after the one given: for a session that is in it again.
 *
 * @param from - The index in the timeline from which on to look.
 * @returns The session, as it was then.
 * @throws Error when it takes too long, or the agent sent a request the test scripted no answer for.
 */
export async function sessionAfter(
  cockpit: ContractCockpit,
  state: SessionState,
  from: number,
): Promise<Session> {
  const deadline = Date.now() + PATIENCE_MS;
  for (;;) {
    const found = cockpit.timeline
      .slice(from)
      .flatMap((moment) => ('session' in moment ? [moment.session] : []))
      .find((session) => session.state === state);
    if (found !== undefined) return found;
    cockpit.api.assertNothingUnexpected();
    if (Date.now() > deadline) {
      throw new Error(
        `Waited ${PATIENCE_MS} ms for a session to be ${state} after moment ${from}.`,
      );
    }
    await pause(HOOK_POLL_MS);
  }
}

/** Gives the server's process the shim's variables, for the test: the driver reads them there. */
function serveFrom(shim: RealAgentShim): void {
  for (const [name, value] of Object.entries(shim.serverVariables)) vi.stubEnv(name, value);
}

/** What a recorded driver keeps. */
interface DriverRecord {
  readonly hooksRead: HookRequest[];
  readonly launches: LaunchCommand[];
  readonly conversationsFollowed: Conversation[];
  readonly askedToResume: Conversation[];
  /** The conversation each key was last launched with. */
  readonly conversations: Map<string, string>;
  readonly timeline: Moment[];
}

/**
 * Gives a driver that keeps what it launched, every hook it read, every
 * conversation it followed and what it told of them, and every conversation
 * it was asked about; nothing of it changes.
 */
function recorded(driver: Driver, record: DriverRecord): Driver {
  return {
    ...driver,
    async launch(launch) {
      const command = await driver.launch(launch);
      record.launches.push(command);
      record.conversations.set(launch.key, launch.conversationId);
      return command;
    },
    readHook(request) {
      record.hooksRead.push(request);
      record.timeline.push({ hook: request.body as HookPayload });
      return driver.readHook(request);
    },
    follow(conversation, report) {
      record.conversationsFollowed.push(conversation);
      return driver.follow(conversation, (events) => {
        record.timeline.push({ told: events });
        report(events);
      });
    },
    canResume(conversation) {
      record.askedToResume.push(conversation);
      return driver.canResume(conversation);
    },
  };
}

/** How long an Enter is given to be confirmed before the box is looked at again, as the driver gives it. */
const SUBMIT_PATIENCE_MS = 3000;
const HOOK_POLL_MS = 50;

interface TerminalSubmit {
  readonly session: AgentSession;
  readonly hooksRead: readonly HookRequest[];
  readonly text: string;
  readonly confirmation: string;
  readonly api: FakeApi;
}

/** Submits what a session's input box holds, as {@link ContractCockpit.submitInTerminal} says. */
async function submittedInTerminal(submit: TerminalSubmit): Promise<HookPayload> {
  const { session, hooksRead, text, confirmation, api } = submit;
  const before = hooksRead.length;
  const confirmed = () =>
    hooksRead
      .slice(before)
      .map((request) => request.body as HookPayload)
      .find((payload) => payload.hook_event_name === confirmation);
  for (let enters = 1; ; enters++) {
    await session.press('Enter');
    const deadline = Date.now() + SUBMIT_PATIENCE_MS;
    while (Date.now() < deadline) {
      api.assertNothingUnexpected();
      const hook = confirmed();
      if (hook !== undefined) return hook;
      await pause(HOOK_POLL_MS);
    }
    const box = inputBoxText(await session.screen());
    const stillHeld = box !== undefined && box.replace(/\s+/gu, '') === text.replace(/\s+/gu, '');
    if (!stillHeld || enters === ENTER_PRESSES) {
      throw new Error(
        `No ${confirmation} came for ${JSON.stringify(text)} after ${enters} Enters; the box holds ${JSON.stringify(box)}.`,
      );
    }
  }
}

interface Following {
  states(key: string): SessionState[];
  sessionIn(key: string, state: SessionState, patienceMs?: number): Promise<Session>;
  stop(): void;
}

/** Follows the cockpit's sessions from now on, keeping each key's states, each change on the timeline. */
function followed(cockpit: Cockpit, api: FakeApi, timeline: Moment[]): Following {
  const seen = new Map<string, Session[]>();
  const waiters = new Set<() => void>();
  const stop = cockpit.sessions.follow((sessions) => {
    for (const session of sessions) {
      const history = seen.get(session.key) ?? [];
      if (history.at(-1)?.state !== session.state) {
        seen.set(session.key, [...history, session]);
        timeline.push({ session });
      }
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
