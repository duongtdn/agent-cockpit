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
   * @throws Error when none comes in time, saying which hooks came and what the sessions show.
   */
  hook(event: string): Promise<ReceivedHook>;
}

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
 * the temporary folders, the receiver and the API's double.
 *
 * @returns The agent, with nothing launched yet.
 */
export async function startContractAgent(): Promise<ContractAgent> {
  // Closed last started first: the sessions end while their hooks still have somewhere to go.
  const closers: (() => Promise<void>)[] = [];
  onTestFinished(async () => {
    for (const close of closers.reverse()) await close();
  });
  const api = await startFakeApi();
  closers.push(() => api.close());
  const hooks = await startHookReceiver();
  closers.push(() => hooks.close());
  const runner = await startRealAgentRunner({
    apiBaseUrl: api.baseUrl,
    settings: { ...hooks.settings(), permissions: PERMISSIONS },
  });
  closers.push(() => runner.close());
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
    hook: (event) => nextHook(hooks, event, sessions),
  };
}

async function nextHook(
  hooks: HookReceiver,
  event: string,
  sessions: readonly AgentSession[],
): Promise<ReceivedHook> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), HOOK_TIMEOUT_MS);
  });
  const hook = await Promise.race([hooks.next(event), late]);
  clearTimeout(timer);
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

/** A text the transcript records as the user's, and when. */
export interface RecordedText {
  readonly text: string;
  /** When the agent recorded it, in milliseconds since the epoch. */
  readonly recordedAt: number;
}

/**
 * Gives the texts a session's transcript records as the user's: the prompts
 * and the markers the agent writes in the user's name.
 *
 * @param session - The session whose transcript is read, as it is now.
 */
export function userTexts(session: AgentSession): RecordedText[] {
  return session
    .transcript()
    .filter((entry) => entry.type === 'user')
    .flatMap((entry) => {
      const { content } = entry.message as { content: unknown };
      const recordedAt = Date.parse(entry.timestamp as string);
      return textsOf(content).map((text) => ({ text, recordedAt }));
    });
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
