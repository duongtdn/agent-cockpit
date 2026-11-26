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

/**
 * The real agent as one contract test has it: a scripted API, a hook
 * receiver and a runner of its own, so that tests and files run side by
 * side without sharing a port, a socket or a folder.
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
   * @throws Error when none comes in time, saying which hooks came and what
   * the sessions show; at once, naming the request, when the agent sent a
   * conversation request the test scripted no answer for.
   */
  hook(event: string): Promise<ReceivedHook>;
  /**
   * Waits until a check passes, for what no event announces: what a session
   * shows, what it has written.
   *
   * @param check - Throws until what is awaited is true.
   * @returns What the check returned when it passed.
   * @throws The check's last error when it never passes in time; at once,
   * naming the request, when the agent sent a conversation request the test
   * scripted no answer for.
   */
  eventually<T>(check: () => T | Promise<T>): Promise<T>;
}

/** Registers what runs when the test finishes, passed or failed. */
export type WhenFinished = (finish: () => Promise<void>) => void;

/** Far longer than the agent takes (a start is under a second), short enough to fail with the reason. */
const HOOK_TIMEOUT_MS = 15_000;

/**
 * The scripted model may run any shell command without an ask: a
 * permission dialog is no part of these behaviors, and the commands are the
 * tests' own, in a temporary folder.
 */
const PERMISSIONS = { allow: ['Bash'] };

/**
 * Starts the real agent's surroundings for the running test, and ends them
 * when the test finishes, passed or failed: the sessions, their tmux server,
 * the temporary folders, the receiver and the API's double. The test then
 * fails if the agent sent a conversation request it scripted no answer for,
 * or if a session left something outside its temporary root.
 *
 * @param whenFinished - Registers the test's end; the running test's by default.
 * @returns The agent, with nothing launched yet.
 */
export async function startContractAgent(
  whenFinished: WhenFinished = onTestFinished,
): Promise<ContractAgent> {
  // Closed last started first: the sessions end while their hooks still have somewhere to go.
  const closers: (() => Promise<void>)[] = [];
  const finalChecks: (() => void)[] = [];
  whenFinished(async () => {
    for (const close of closers.reverse()) await close();
    // After the closing: a check that fails leaves nothing running.
    for (const check of finalChecks) check();
  });
  const api = await startFakeApi();
  closers.push(() => api.close());
  finalChecks.push(() => api.assertNothingUnexpected());
  const hooks = await startHookReceiver();
  closers.push(() => hooks.close());
  const runner = await startRealAgentRunner({
    apiBaseUrl: api.baseUrl,
    settings: { ...hooks.settings(), permissions: PERMISSIONS },
  });
  closers.push(() => runner.close());
  finalChecks.push(() => expect(runner.leftOutsideRoot()).toEqual([]));
  const sessions: AgentSession[] = [];
  const remembered = async (launching: Promise<AgentSession>) => {
    const session = await launching;
    sessions.push(session);
    return session;
  };

  return {
    api,
    hooks,
    workFolder: runner.workFolder,
    startNew: (options) => remembered(runner.startNew(options)),
    resume: (sessionId, options) => remembered(runner.resume(sessionId, options)),
    hook: (event) => nextHook(api, hooks, event, sessions),
    eventually: (check) => eventually(check, () => api.assertNothingUnexpected()),
  };
}

async function nextHook(
  api: FakeApi,
  hooks: HookReceiver,
  event: string,
  sessions: readonly AgentSession[],
): Promise<ReceivedHook> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), HOOK_TIMEOUT_MS);
  });
  // The session of an unscripted request stops there: the hook would never come.
  const hook = await Promise.race([hooks.next(event), late, api.unexpectedRequest()]).finally(() =>
    clearTimeout(timer),
  );
  if (hook instanceof Error) throw hook;
  if (hook !== 'late') return hook;
  const screens = await Promise.all(sessions.map((session) => session.screen().catch(() => '')));
  throw new Error(
    [
      `No ${event} hook within ${HOOK_TIMEOUT_MS} ms. Hooks received: ${hooks.events().join(', ') || 'none'}.`,
      ...screens.filter((screen) => screen !== '').map((screen) => `A session shows:\n${screen}`),
    ].join('\n'),
  );
}

/**
 * Signals a session's agent and waits until the session is gone.
 *
 * @param session - A session that lives.
 * @param signal - `SIGTERM`, on which the agent exits by itself, or `SIGKILL`.
 */
export async function endSession(
  session: AgentSession,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  process.kill(await session.processId(), signal);
  await eventually(async () => expect(await session.isLive()).toBe(false));
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
