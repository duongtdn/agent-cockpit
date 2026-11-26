import { expect, onTestFinished } from 'vitest';
import { eventually } from '../support/eventually.ts';
import { type FakeApi, type LoggedRequest, startFakeApi } from '../support/fake-api/index.ts';
import {
  type HookReceiver,
  type ReceivedHook,
  startHookReceiver,
} from '../support/hooks/hook-receiver.ts';
import {
  type AgentSession,
  type LaunchOptions,
  startRealAgentRunner,
} from '../support/real-agent/runner.ts';
import { runAll } from '../support/run-all.ts';

/**
 * The real agent as one contract test has it: a scripted API, a hook
 * receiver and a runner of its own, so that tests and files run side by
 * side without sharing a port, a socket or a folder.
 *
 * Every wait it offers fails by itself, with the reason: when it lasts too
 * long, saying what was awaited, which hooks came and what the sessions
 * show; at once, naming the request, when the agent sent a conversation
 * request the test scripted no answer for; at once, naming the session and
 * its last screen, when a session is gone that the test did not end.
 */
export interface ContractAgent {
  /** The scripted double of the API the agent talks to. */
  readonly api: FakeApi;
  /** Where the agent's hooks arrive. */
  readonly hooks: HookReceiver;
  /** The folder the sessions work in. */
  readonly workFolder: string;
  /** Launches a new conversation; the agent is still starting when it returns. */
  startNew(options?: LaunchOptions): Promise<AgentSession>;
  /** Launches the agent on a conversation it already has. */
  resume(sessionId: string, options?: LaunchOptions): Promise<AgentSession>;
  /**
   * Waits for the next hook of an event that no earlier call was given.
   *
   * @throws Error as every wait of the agent's.
   */
  hook(event: string): Promise<ReceivedHook>;
  /**
   * Waits for something a double promises: a request the API holds, the
   * end of a hold.
   *
   * @param what - What is awaited, for the failure to say.
   * @param awaited - The promise of it.
   * @returns What was promised.
   * @throws Error as every wait of the agent's.
   */
  waitFor<T>(what: string, awaited: Promise<T>): Promise<T>;
  /**
   * Waits until a check passes, for what no event announces: what a session
   * shows, what it has written.
   *
   * @param check - Throws until what is awaited is true.
   * @returns What the check returned when it passed.
   * @throws The check's last error when it never passes in time; at once,
   * for an unscripted request or a session that is gone, as every wait.
   */
  eventually<T>(check: () => T | Promise<T>): Promise<T>;
  /**
   * Signals a session's agent and waits until the session is gone. The
   * waits no longer fail on that session being gone.
   *
   * @param session - A session that lives.
   * @param signal - `SIGTERM`, on which the agent exits by itself, or `SIGKILL`.
   */
  end(session: AgentSession, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

/** Registers what runs when the test finishes, passed or failed. */
export type WhenFinished = (finish: () => Promise<void>) => void;

/** What a test may choose about its agent's surroundings. */
export interface ContractAgentOptions {
  /** Registers the test's end; the running test's by default. */
  readonly whenFinished?: WhenFinished;
  /** How long a wait may last before it fails, in milliseconds. */
  readonly patienceMs?: number;
}

/** Far longer than the agent takes (a start is under a second), short enough to fail with the reason. */
const PATIENCE_MS = 15_000;

/**
 * The scripted model may run any shell command without an ask: a
 * permission dialog is no part of these behaviors, and the commands are the
 * tests' own, in a temporary folder.
 */
const PERMISSIONS = { allow: ['Bash'] };

/**
 * The requests the agent makes to paths the API's double does not know, and
 * is content to see refused. Any other is a call nothing here answers as
 * the API would: the test fails on it.
 */
const EXPECTED_UNKNOWN_REQUESTS: readonly string[] = ['HEAD /api/hello'];

/**
 * Starts the real agent's surroundings for the running test, and ends them
 * when the test finishes, passed or failed: the sessions, their tmux server,
 * the temporary folders, the receiver and the API's double — each of them,
 * whatever the others did. The test then fails if the agent sent a
 * conversation request it scripted no answer for or a request to a path
 * nobody expects, or if a session left something outside its temporary
 * root; every such failure is reported.
 *
 * @param options - See {@link ContractAgentOptions}.
 * @returns The agent, with nothing launched yet.
 */
export async function startContractAgent(
  options: ContractAgentOptions = {},
): Promise<ContractAgent> {
  const { whenFinished = onTestFinished, patienceMs = PATIENCE_MS } = options;
  // Closed last started first: the sessions end while their hooks still have somewhere to go.
  const closers: (() => Promise<void>)[] = [];
  const finalChecks: (() => void)[] = [];
  // The checks after the closing: one that fails leaves nothing running.
  whenFinished(() => runAll([...closers.reverse(), ...finalChecks]));
  const api = await startFakeApi();
  closers.push(() => api.close());
  finalChecks.push(
    () => api.assertNothingUnexpected(),
    () => assertNoUnexpectedPath(api),
  );
  const hooks = await startHookReceiver();
  closers.push(() => hooks.close());
  const runner = await startRealAgentRunner({
    apiBaseUrl: api.baseUrl,
    settings: { ...hooks.settings(), permissions: PERMISSIONS },
  });
  closers.push(() => runner.close());
  finalChecks.push(() => expect(runner.leftOutsideRoot()).toEqual([]));
  const sessions = watchedSessions();
  const waits = failFastWaits({ api, hooks, sessions, patienceMs });
  const launched = async (launching: Promise<AgentSession>) => sessions.watch(await launching);

  return {
    api,
    hooks,
    workFolder: runner.workFolder,
    startNew: (launchOptions) => launched(runner.startNew(launchOptions)),
    resume: (sessionId, launchOptions) => launched(runner.resume(sessionId, launchOptions)),
    hook: (event) => waits.waitFor(`a ${event} hook`, hooks.next(event)),
    waitFor: waits.waitFor,
    eventually: waits.eventually,
    end: async (session, signal) => {
      sessions.expectEndOf(session);
      process.kill(await session.processId(), signal);
      await waits.waitFor(`the session ${session.name} to be gone`, session.ended);
    },
  };
}

function assertNoUnexpectedPath(api: FakeApi): void {
  const unexpected = api
    .unknownRequests()
    .map((request) => `${request.method} ${request.path}`)
    .filter((request) => !EXPECTED_UNKNOWN_REQUESTS.includes(request));
  if (unexpected.length === 0) return;
  throw new Error(
    [
      `Requests to paths the API's double does not know (${unexpected.length}):`,
      ...unexpected.map((request) => `  ${request}`),
    ].join('\n'),
  );
}

/** The sessions a test launched, and the news of one that went without the test ending it. */
interface WatchedSessions {
  /** Every session launched, the gone ones too. */
  readonly all: readonly AgentSession[];
  /** Watches a session from now on; gives it back. */
  watch(session: AgentSession): AgentSession;
  /** Tells that the test ends a session itself: its going is no failure. */
  expectEndOf(session: AgentSession): void;
  /** Fulfilled with the failure once a session is gone unexpectedly; pending until then. */
  readonly unexpectedEnd: Promise<Error>;
  /**
   * The check of a wait that polls.
   *
   * @throws The failure, once a session is gone unexpectedly.
   */
  assertNoneGone(): void;
}

function watchedSessions(): WatchedSessions {
  const all: AgentSession[] = [];
  const endedByTheTest = new Set<AgentSession>();
  let failure: Error | undefined;
  let tell: (error: Error) => void = () => {};
  const unexpectedEnd = new Promise<Error>((resolve) => {
    tell = resolve;
  });

  async function watch(session: AgentSession): Promise<void> {
    const { lastScreen } = await session.ended;
    if (endedByTheTest.has(session) || failure !== undefined) return;
    failure = new Error(
      [
        `The session ${session.name} is gone: its agent exited, and the test did not end it.`,
        lastScreen === undefined ? 'It was gone before its screen was read.' : shown(lastScreen),
      ].join('\n'),
    );
    tell(failure);
  }

  return {
    all,
    watch(session) {
      all.push(session);
      void watch(session);
      return session;
    },
    expectEndOf: (session) => void endedByTheTest.add(session),
    unexpectedEnd,
    assertNoneGone() {
      if (failure !== undefined) throw failure;
    },
  };
}

function shown(screen: string): string {
  return `A session shows:\n${screen}`;
}

/** What the waits of an agent look at to fail with a reason. */
interface WaitSurroundings {
  readonly api: FakeApi;
  readonly hooks: HookReceiver;
  readonly sessions: WatchedSessions;
  readonly patienceMs: number;
}

/** The waits of {@link ContractAgent}, which fail as it says. */
function failFastWaits({
  api,
  hooks,
  sessions,
  patienceMs,
}: WaitSurroundings): Pick<ContractAgent, 'waitFor' | 'eventually'> {
  async function tooLong(what: string): Promise<Error> {
    const screens = await Promise.all(
      sessions.all.map((session) => session.screen().catch(() => undefined)),
    );
    return new Error(
      [
        `Waited ${patienceMs} ms for ${what}. Hooks received: ${hooks.events().join(', ') || 'none'}.`,
        ...screens.filter((screen) => screen !== undefined).map(shown),
      ].join('\n'),
    );
  }

  async function waitFor<T>(what: string, awaited: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Error>((resolve) => {
      timer = setTimeout(() => resolve(tooLong(what)), patienceMs);
    });
    // After either, what is awaited would never come: the session stopped there, or is no more.
    const stopped = Promise.race([late, api.unexpectedRequest(), sessions.unexpectedEnd]);
    const outcome = await Promise.race([
      awaited.then((value) => ({ value })),
      stopped.then((failure) => ({ failure })),
    ]).finally(() => clearTimeout(timer));
    if ('failure' in outcome) throw outcome.failure;
    return outcome.value;
  }

  return {
    waitFor,
    eventually: (check) =>
      eventually(check, () => {
        api.assertNothingUnexpected();
        sessions.assertNoneGone();
      }),
  };
}

/** Gives the texts of a list of content blocks, or the content itself when it is a text. */
function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: { type?: unknown; text?: unknown }) =>
    block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  );
}

/**
 * Gives every text of the conversation a request carried, in order: the
 * prompts, the answers, and what the agent adds around them.
 *
 * @param request - A request the API's double logged.
 */
export function conversationTexts(request: LoggedRequest): string[] {
  return (request.body?.messages ?? []).flatMap((message) => textsOf(message.content));
}

/**
 * Gives the texts a session's transcript records as the user's: the prompts
 * and the markers the agent writes in the user's name.
 *
 * @param session - The session whose transcript is read, as it is now.
 * @returns The texts, in the order of the transcript.
 */
export function userTexts(session: AgentSession): string[] {
  return session
    .transcript()
    .filter((entry) => entry.type === 'user')
    .flatMap((entry) => textsOf((entry.message as { content: unknown }).content));
}

/**
 * Gives what a session's input box holds: the text between the two rules
 * above the footer, without the prompt sign and the blank after it. A prompt that was submitted
 * shows above the box, not in it.
 *
 * @param screen - What the session's terminal shows.
 * @returns The box's text, or `undefined` when the screen shows no input box.
 */
export function inputBoxText(screen: string): string | undefined {
  const lines = screen.split('\n');
  const isRule = (line: string) => /^─+$/.test(line);
  const bottom = lines.findLastIndex(isRule);
  const top = lines.slice(0, Math.max(bottom, 0)).findLastIndex(isRule);
  if (top === -1) return undefined;
  return lines
    .slice(top + 1, bottom)
    .join('\n')
    .replace(/^❯\s/u, '');
}
