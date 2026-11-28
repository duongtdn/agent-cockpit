import { setTimeout as pause } from 'node:timers/promises';
import { expect, onTestFinished, type RunnerTestCase, type TaskMeta, TestRunner } from 'vitest';
import { type InputBoxView, readInputBoxView } from '../../src/claude-code/screen-reading.ts';
import { eventually } from '../support/eventually.ts';
import { type FakeApi, type LoggedRequest, startFakeApi } from '../support/fake-api/index.ts';
import {
  type HookReceiver,
  type ReceivedHook,
  startHookReceiver,
} from '../support/hooks/hook-receiver.ts';
import { PATIENCE } from '../support/patience.ts';
import {
  type AgentSession,
  type LaunchOptions,
  type RealAgentRunner,
  type RealAgentRunnerOptions,
  startRealAgentRunner,
} from '../support/real-agent/runner.ts';
import { runAll } from '../support/run-all.ts';
import type { LostEnters } from './results.ts';

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
  /**
   * Waits until a session's agent exits by itself, as the test expects it
   * to: the waits no longer fail on that session being gone. Called before
   * what makes it leave, so that its end is never taken for an unexpected one.
   *
   * @param session - A session that lives.
   * @returns Fulfilled once the session is gone.
   * @throws Error as every wait of the agent's.
   */
  exits(session: AgentSession): Promise<void>;
  /**
   * Keeps, in the test's results, the Enters a submit pressed before the one
   * the agent took: no failure, since the driver absorbs a lost Enter, but
   * what a run should show.
   */
  noteLostEnters(lost: LostEnters): void;
}

/** Registers what runs when the test finishes, passed or failed. */
export type WhenFinished = (finish: () => Promise<void>) => void;

/** What a test may choose about its agent's surroundings. */
export interface ContractAgentOptions {
  /** Registers the test's end; the running test's by default. */
  readonly whenFinished?: WhenFinished;
  /**
   * The test's metadata, where the run's results read what the test noted;
   * the running test's by default.
   */
  readonly meta?: TaskMeta;
  /** How long a wait may last before it fails, in milliseconds. */
  readonly patienceMs?: number;
  /**
   * The `permissions` of the sessions' settings; by default every shell
   * command runs without an ask. A test of the ask itself gives its own.
   */
  readonly permissions?: object;
  /** What the runner leaves out of the configuration and gives the agent beside it: see {@link RealAgentRunnerOptions}. */
  readonly runner?: Pick<RealAgentRunnerOptions, 'leftOutOfRecipe' | 'variables'>;
}

/**
 * The scripted model may run any shell command without an ask: a
 * permission dialog is no part of these behaviors, and the commands are the
 * tests' own, in a temporary folder.
 */
export const NO_ASK_FOR_SHELL_COMMANDS = { allow: ['Bash'] };

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
  const {
    whenFinished = onTestFinished,
    meta = runningTestMeta(),
    patienceMs = PATIENCE.agentStep,
    permissions = NO_ASK_FOR_SHELL_COMMANDS,
  } = options;
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
    settings: sessionSettings(hooks, permissions),
    ...options.runner,
  });
  closers.push(() => runner.close());
  finalChecks.push(() => expect(runner.leftOutsideRoot()).toEqual([]));
  return { api, ...drivenAgent({ api, hooks, launcher: runner, meta, patienceMs }) };
}

function runningTestMeta(): TaskMeta {
  const test = TestRunner.getCurrentTest<RunnerTestCase | undefined>();
  if (test === undefined) throw new Error('No test runs: give the meta of the test.');
  return test.meta;
}

/** An agent's sessions as a test drives them, whatever the agent talks to. */
export type DrivenAgent = Omit<ContractAgent, 'api'>;

/** What launches an agent's sessions in one work folder: the real agent's runner, or a fake agent's. */
export type Launcher = Pick<RealAgentRunner, 'workFolder' | 'startNew' | 'resume'>;

/** What a driven agent is made of. */
export interface DrivenAgentParts {
  /** The API's double, when the agent talks to one: its waits then fail on a request with no scripted answer. */
  readonly api?: FakeApi;
  /** Where the agent's hooks arrive. */
  readonly hooks: HookReceiver;
  /** What launches its sessions. */
  readonly launcher: Launcher;
  /** The test's metadata, where the run's results read what the test noted. */
  readonly meta: TaskMeta;
  /** How long a wait may last before it fails, in milliseconds; as {@link ContractAgentOptions} by default. */
  readonly patienceMs?: number;
}

/**
 * Gives an agent, real or fake, the sessions and the waits of
 * {@link ContractAgent}. Nothing is started and nothing is closed here.
 *
 * @param parts - See {@link DrivenAgentParts}.
 * @returns The agent, with nothing launched yet.
 */
export function drivenAgent(parts: DrivenAgentParts): DrivenAgent {
  const { hooks, launcher, meta } = parts;
  const sessions = watchedSessions();
  const waits = failFastWaits({
    ...parts,
    sessions,
    patienceMs: parts.patienceMs ?? PATIENCE.agentStep,
  });
  const launched = async (launching: Promise<AgentSession>) => sessions.watch(await launching);

  return {
    hooks,
    workFolder: launcher.workFolder,
    startNew: (launchOptions) => launched(launcher.startNew(launchOptions)),
    resume: (sessionId, launchOptions) => launched(launcher.resume(sessionId, launchOptions)),
    hook: (event) => waits.waitFor(`a ${event} hook`, hooks.next(event)),
    waitFor: waits.waitFor,
    eventually: waits.eventually,
    end: async (session, signal) => {
      sessions.expectEndOf(session);
      process.kill(await session.processId(), signal);
      await waits.waitFor(`the session ${session.name} to be gone`, session.ended);
    },
    exits: async (session) => {
      sessions.expectEndOf(session);
      await waits.waitFor(`the session ${session.name} to be gone`, session.ended);
    },
    noteLostEnters: (lost) => {
      meta.lostEnters = [...(meta.lostEnters ?? []), lost];
    },
  };
}

/**
 * Gives the settings of an agent's sessions, real or fake: every hook to a
 * receiver, and the permissions.
 *
 * @param hooks - Where the hooks arrive.
 * @param permissions - The `permissions` of the settings.
 */
export function sessionSettings(hooks: HookReceiver, permissions: object): object {
  return { ...hooks.settings(), permissions };
}

/**
 * Fails when the agent sent a request to a path the API's double does not
 * know and nobody expects.
 *
 * @param api - The API's double.
 * @throws Error naming each such request.
 */
export function assertNoUnexpectedPath(api: FakeApi): void {
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
  readonly api?: FakeApi;
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
    const unscripted = api === undefined ? [] : [api.unexpectedRequest()];
    const stopped = Promise.race([late, ...unscripted, sessions.unexpectedEnd]);
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
        api?.assertNothingUnexpected();
        sessions.assertNoneGone();
      }),
  };
}

/** Gives the texts of a list of content blocks, or the content itself when it is a text. */
function contentTexts(content: unknown): string[] {
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
  return (request.body?.messages ?? []).flatMap((message) => contentTexts(message.content));
}

/** What the agent records in the user's name when a turn is interrupted while it writes. */
export const INTERRUPTED = '[Request interrupted by user]';

/** What the agent records in the user's name when a turn is interrupted while a tool call is open. */
export const INTERRUPTED_FOR_TOOL_USE = '[Request interrupted by user for tool use]';

/**
 * Gives the texts a session's transcript records in one side's name: the
 * user's (the prompts, and the markers the agent writes in the user's
 * name) or the assistant's (its answers, as far as each was written).
 *
 * @param session - The session whose transcript is read, as it is now.
 * @param type - Whose texts: `user` or `assistant`.
 * @returns The texts, in the order of the transcript.
 */
export function textsOf(session: AgentSession, type: 'user' | 'assistant'): string[] {
  return session
    .transcript()
    .filter((entry) => entry.type === type)
    .flatMap((entry) => contentTexts((entry.message as { content: unknown }).content));
}

/**
 * Gives the texts a session's transcript records as the user's, as
 * {@link textsOf} does: the prompts and the markers.
 *
 * @param session - The session whose transcript is read, as it is now.
 * @returns The texts, in the order of the transcript.
 */
export function userTexts(session: AgentSession): string[] {
  return textsOf(session, 'user');
}

/**
 * Reads a session's input box as the driver reads it.
 *
 * @param session - The session whose screen is read, as it is now.
 * @returns The box; `undefined` when the screen shows none.
 */
export async function boxOf(session: AgentSession): Promise<InputBoxView | undefined> {
  return readInputBoxView(await session.screen());
}

/**
 * Types a draft into a session's input box as a person does, a line break
 * as Alt+Enter, and waits until the box shows its end (a line wider than
 * the box shows on several rows: its end is what the box ends with).
 *
 * @param session - The session, its input box showing.
 * @param draft - The draft, its lines apart by `\n`.
 * @throws Error when the box does not show it within the bound of the agent's step.
 */
export async function typeDraft(session: AgentSession, draft: string): Promise<void> {
  for (const [index, line] of draft.split('\n').entries()) {
    if (index > 0) await session.press('M-Enter');
    if (line !== '') await session.type(line);
  }
  const bare = (text: string) => text.replace(/\s+/gu, '');
  const end = bare(draft).slice(-100);
  await eventually(
    async () => {
      expect(bare((await boxOf(session))?.text ?? '').endsWith(end)).toBe(true);
    },
    undefined,
    PATIENCE.agentStep,
  );
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

/**
 * Gives the spinner's row of a screen: a sign, words that end in `…`, and
 * what it waits for in brackets, as the last row of the conversation above
 * the input box (the rows under it, a tip or the effort's, are indented).
 * A busy agent draws it; an idle one does not.
 *
 * @param screen - What the session's terminal shows.
 * @returns The row; `undefined` when the screen shows none, or no input box.
 */
export function spinnerRow(screen: string): string | undefined {
  const box = readInputBoxView(screen);
  if (box === undefined) return undefined;
  const last = screen
    .split('\n')
    .slice(0, box.firstRow - 1)
    .findLast((row) => row.trim() !== '' && !row.startsWith(' '));
  return last !== undefined && /^\S \S[^…]*…/u.test(last) ? last : undefined;
}

/** How many times Enter is pressed on a prompt that stays in the box, as the driver does. */
const ENTER_PRESSES = 3;

/** What a submit gave. */
export interface Submitted {
  /** The hook that confirms the submit: `UserPromptSubmit`, which carries the prompt, unless the submit said another. */
  readonly hook: ReceivedHook;
  /** How many Enters it took: more than one when the agent lost one. */
  readonly enters: number;
}

/**
 * Types a prompt into an idle session and submits it as the driver does,
 * with {@link submitInputBox}.
 *
 * @param agent - The agent, real or fake, whose hooks tell of the submit.
 * @param session - An idle session, its input box empty.
 * @param prompt - The prompt, on one line.
 * @returns The hook that carries the prompt, and the Enters it took.
 * @throws Error as {@link submitInputBox}.
 */
export async function submitPrompt(
  agent: DrivenAgent,
  session: AgentSession,
  prompt: string,
): Promise<Submitted> {
  await session.type(prompt);
  const submitted = await submitInputBox(agent, session, (box) => sameText(box, prompt));
  expect(submitted.hook.payload.prompt).toBe(prompt);
  return submitted;
}

/**
 * Submits what an idle session's input box holds as the driver does: Enter,
 * then a few seconds for the `UserPromptSubmit` (or the event that confirms
 * a local command, such as `PreCompact` for `/compact`); when none came and the box
 * still holds the text, Enter again, up to three times. The agent has been
 * seen to miss an Enter, so a submit is confirmed, never assumed. Each Enter
 * before the one taken is noted in the test's results.
 *
 * @param agent - The agent, real or fake, whose hooks tell of the submit.
 * @param session - An idle session, the text in its input box.
 * @param stillHolds - Tells whether the box, as {@link inputBoxText} gives
 * it, still holds the text: once it does not, the text was taken.
 * @param confirmation - The event that tells the text was taken; `UserPromptSubmit` by default.
 * @returns The hook that carries the text, and the Enters it took.
 * @throws Error when the box still holds the text after the last Enter, or
 * as every wait of the agent's.
 */
export async function submitInputBox(
  agent: DrivenAgent,
  session: AgentSession,
  stillHolds: (box: string) => boolean,
  confirmation = 'UserPromptSubmit',
): Promise<Submitted> {
  // Claimed once, before the first Enter: whichever Enter is taken, its hook is this one. It
  // never fails and keeps no timer, so nothing runs on when the submit throws.
  const submitted = agent.hooks.next(confirmation);
  for (let enters = 1; ; enters++) {
    await session.press('Enter');
    // Each Enter has a few seconds of its own; the agent's wait adds only its failing fast.
    const hook = await waitAWhile(
      agent,
      `a ${confirmation} after Enter ${enters}`,
      submitted,
      PATIENCE.submit,
    );
    if (hook !== undefined) return noted(agent, { hook, enters });
    const box = inputBoxText(await session.screen());
    if (box === undefined || !stillHolds(box)) {
      // Out of the box, the text was taken and its hook is on its way: another Enter would be
      // the agent's next key. The hook gets the agent's whole patience from now.
      const late = await agent.waitFor(`the ${confirmation} of a text the box let go`, submitted);
      return noted(agent, { hook: late, enters });
    }
    if (enters === ENTER_PRESSES) {
      throw new Error(
        `The input box still holds ${JSON.stringify(box)} after ${ENTER_PRESSES} Enters, ${PATIENCE.submit} ms apart, and no ${confirmation} came.`,
      );
    }
  }
}

function noted(agent: DrivenAgent, submitted: Submitted): Submitted {
  if (submitted.enters > 1) {
    agent.noteLostEnters({
      prompt: String(submitted.hook.payload.prompt),
      lost: submitted.enters - 1,
    });
  }
  return submitted;
}

/**
 * Tells whether an input box holds a text, whatever whitespace it drew: a
 * text wider than the box is wrapped onto lines, at a space or inside a
 * word, so the box's spaces and line breaks are not surely the text's.
 *
 * @param box - What the box holds, as {@link inputBoxText} gives it.
 * @param text - The text.
 */
export function sameText(box: string, text: string): boolean {
  const bare = (drawn: string) => drawn.replace(/\s+/gu, '');
  return bare(box) === bare(text);
}

/**
 * Waits as the agent does, but only for a while.
 *
 * @returns What the promise fulfilled with, or `undefined` when it is later.
 * @throws Error as every wait of the agent's; no timer outlives it either way.
 */
async function waitAWhile<T>(
  agent: DrivenAgent,
  what: string,
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  const timeout = new AbortController();
  const late = pause(ms, undefined, { signal: timeout.signal }).catch(() => undefined);
  try {
    return await agent.waitFor(what, Promise.race([promise, late]));
  } finally {
    timeout.abort();
  }
}
