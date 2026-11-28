import type { HeldHook, HookHold } from '../../src/server/agent-listener/agent-listener.ts';
import { Asks } from '../../src/server/asks/asks.ts';
import type {
  AskOfCall,
  ClearingTerminal,
  Conversation,
  Driver,
  DriverEvent,
  FollowedConversation,
  HookOutcome,
  HookRequest,
  InputBox,
  InputBoxClearing,
  JsonValue,
  Launch,
  LaunchCommand,
  ScreenReading,
  TypingOutcome,
  TypingTerminal,
} from '../../src/server/driver.ts';
import type {
  Attachment,
  SessionHost,
  StartOptions,
  TerminalSize,
} from '../../src/server/session-host/session-host.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import type { HookAccess, SessionFolders } from '../../src/server/sessions/sessions.ts';
import type { RecordStore, UnitRecord } from '../../src/server/state/records.ts';
import type { StartupDialog } from '../../src/shared/session.ts';
import { DRIVER_DEFAULTS } from './driver-defaults.ts';

/**
 * The hold a test gives `receive` for a hook it does not hold: the core
 * taking it fails the test.
 */
export function holdNoHook(): HeldHook {
  throw new Error('This test holds no hook request.');
}

/** What became of a held hook: still open, replied to, released with `{}`, or closed by the agent. */
export type HeldHookEnd = 'open' | 'replied' | 'released' | 'closed';

/** A hook request held as the agent-facing listener holds one, which a test closes as the agent would. */
export interface FakeHeldHook extends HeldHook {
  /** What became of it so far. */
  readonly end: HeldHookEnd;
  /** Every body the core asked to write, in order, whether or not it was written. */
  readonly replies: JsonValue[];
  /** How many times the core let it go. */
  readonly releases: number;
  /** The agent closes the connection: `onClosed` is called, once, if it was open. */
  closeByAgent(): void;
  /**
   * The connection breaks unseen: the next write finds it closed, and
   * `onClosed` comes only when the test closes it.
   */
  breakUnseen(): void;
}

/** The hold a test gives `receive`: each request held is kept, in order. */
export interface FakeHolds {
  readonly hold: HookHold;
  readonly held: FakeHeldHook[];
}

/** Creates a hold that keeps each request held, for a test to answer or close as the agent would. */
export function createFakeHolds(): FakeHolds {
  const held: FakeHeldHook[] = [];
  const hold: HookHold = (onClosed) => {
    let end: HeldHookEnd = 'open';
    let broken = false;
    const replies: JsonValue[] = [];
    let releases = 0;
    const hook: FakeHeldHook = {
      get end() {
        return end;
      },
      replies,
      get releases() {
        return releases;
      },
      reply(body) {
        replies.push(body);
        if (end !== 'open' || broken) return 'closed';
        end = 'replied';
        return 'written';
      },
      release() {
        releases += 1;
        if (end === 'open' && !broken) end = 'released';
      },
      closeByAgent() {
        if (end !== 'open') return;
        end = 'closed';
        onClosed();
      },
      breakUnseen() {
        broken = true;
      },
    };
    held.push(hook);
    return hook;
  };
  return { hold, held };
}

/**
 * The asks of a test's sessions, on the real clock (a test's fake one): a
 * handler that throws fails the test.
 */
export function createTestAsks(): Asks {
  return new Asks({
    clock: () => new Date(),
    handlerThrew: (thrown) => {
      throw thrown;
    },
  });
}

/** What a deferred host call waits for: the test settles it. */
interface Gate {
  readonly promise: Promise<void>;
  open(): void;
  fail(error: unknown): void;
}

function gate(): Gate {
  let open = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

/** An attachment a test ends by hand. */
export interface FakeAttachment extends Attachment {
  /** Ends it, as the host does when its session is gone. */
  end(): void;
}

function fakeAttachment(): FakeAttachment {
  const ends: (() => void)[] = [];
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const listener of ends) listener();
  };
  return {
    onData: () => () => {},
    onEnd(listener) {
      if (ended) listener();
      else ends.push(listener);
      return () => {};
    },
    write: () => {},
    resize: () => {},
    detach: async () => end(),
    end,
  };
}

/**
 * A session host in memory: sessions live from their start until the test
 * says they are gone, or one is killed. Only what the sessions core uses
 * does anything; the rest refuses, so that a test sees a new use.
 */
export interface FakeHost extends SessionHost {
  /** The options of every start, in order. */
  readonly starts: StartOptions[];
  /** The names of every kill, in order. */
  readonly kills: string[];
  /** How many times the sessions were listed. */
  readonly listings: number;
  /** The attachments given, in order. */
  readonly attachments: FakeAttachment[];
  /** How many times a screen was read. */
  readonly screenReads: number;
  /** Every write into a session, in order: `<name> text:<text>`, or `<name> ` and the keys pressed joined by spaces. */
  readonly writes: string[];
  /** The process id of a live session, as `processOf` gives it. */
  pidOf(name: string): number | undefined;
  /** Makes the session count this many terminals attached: none until then. */
  attachTerminals(name: string, count: number): void;
  /** Makes a session's screen show the text from now on: blank until then. */
  show(name: string, text: string): void;
  /** Makes the session's screen read as scrolled back by a person, or not. */
  scrollBack(name: string, scrolled: boolean): void;
  /** Makes a session live, as one left by an earlier run. */
  leave(name: string): void;
  /** Makes a session gone, as when its process exits. */
  exit(name: string): void;
  /** Makes the next start fail with the error. */
  failNextStart(error: unknown): void;
  /** Makes the next start wait until the test opens the gate it returns. */
  holdNextStart(): Gate;
  /** Makes the next list wait until the test opens the gate it returns. */
  holdNextList(): Gate;
  /** Makes every list fail, or work again. */
  failLists(failing: boolean): void;
  /** Makes the next kill fail with the error. */
  failNextKill(error: unknown): void;
  /** Makes the next kill wait until the test opens the gate it returns. */
  holdNextKill(): Gate;
  /** Makes every question whether a session lives fail, or work again. */
  failIsLive(failing: boolean): void;
  /** Makes the next attach fail with the error. */
  failNextAttach(error: unknown): void;
  /** Makes the next count of attached terminals wait until the test opens the gate it returns. */
  holdNextCount(): Gate;
}

export function createFakeHost(): FakeHost {
  const live = new Set<string>();
  const starts: StartOptions[] = [];
  const kills: string[] = [];
  const attachments: FakeAttachment[] = [];
  let listings = 0;
  let screenReads = 0;
  const writes: string[] = [];
  const pids = new Map<string, number>();
  const attached = new Map<string, number>();
  const refuseWriteUnlessLive = (name: string) => {
    if (!live.has(name)) throw new SessionHostError('no-session', `${name} does not live.`);
  };
  const screens = new Map<string, string>();
  const scrolled = new Set<string>();
  let nextStart: { error?: unknown; gate?: Gate } = {};
  let nextList: Gate | undefined;
  let listsFail = false;
  let nextKillError: unknown;
  let nextKill: Gate | undefined;
  let isLiveFails = false;
  let nextAttachError: unknown;
  let nextCount: Gate | undefined;
  const unused = () => Promise.reject(new Error('The sessions core does not use this.'));

  return {
    starts,
    kills,
    attachments,
    writes,
    pidOf: (name) => (live.has(name) ? pids.get(name) : undefined),
    attachTerminals: (name, count) => void attached.set(name, count),
    get listings() {
      return listings;
    },
    get screenReads() {
      return screenReads;
    },
    show: (name, text) => void screens.set(name, text),
    scrollBack: (name, scrolledBack) =>
      void (scrolledBack ? scrolled.add(name) : scrolled.delete(name)),
    leave: (name) => void live.add(name),
    exit: (name) => void live.delete(name),
    failNextStart(error) {
      nextStart = { error };
    },
    holdNextStart() {
      const held = gate();
      nextStart = { gate: held };
      return held;
    },
    holdNextList() {
      nextList = gate();
      return nextList;
    },
    failLists(failing) {
      listsFail = failing;
    },
    failNextKill(error) {
      nextKillError = error;
    },
    holdNextKill() {
      nextKill = gate();
      return nextKill;
    },
    failIsLive(failing) {
      isLiveFails = failing;
    },
    failNextAttach(error) {
      nextAttachError = error;
    },
    holdNextCount() {
      nextCount = gate();
      return nextCount;
    },
    checkMachine: unused,
    async start(options) {
      const { error, gate: held } = nextStart;
      nextStart = {};
      starts.push(options);
      if (held) await held.promise;
      if (error !== undefined) throw error;
      if (live.has(options.name)) {
        throw new SessionHostError('session-exists', `${options.name} lives.`);
      }
      live.add(options.name);
      pids.set(options.name, 1000 + starts.length);
    },
    async list() {
      listings += 1;
      const seen = [...live];
      const held = nextList;
      nextList = undefined;
      if (held) await held.promise;
      if (listsFail) throw new SessionHostError('host-failed', 'tmux failed.');
      return seen;
    },
    async isLive(name) {
      if (isLiveFails) throw new SessionHostError('host-failed', 'tmux failed.');
      return live.has(name);
    },
    async processOf(name) {
      const pid = live.has(name) ? pids.get(name) : undefined;
      return pid === undefined ? undefined : { pid };
    },
    async sendText(name, text) {
      refuseWriteUnlessLive(name);
      writes.push(`${name} text:${text}`);
    },
    async sendKeys(name, keys) {
      refuseWriteUnlessLive(name);
      writes.push(`${name} ${keys.join(' ')}`);
    },
    sendBytes: unused,
    async readScreen(name) {
      screenReads += 1;
      if (!live.has(name)) throw new SessionHostError('no-session', `${name} does not live.`);
      return {
        text: screens.get(name) ?? '',
        cursor: { row: 0, column: 0 },
        inCopyMode: scrolled.has(name),
      };
    },
    async attach(name: string, _size: TerminalSize) {
      const error = nextAttachError;
      nextAttachError = undefined;
      if (error !== undefined) throw error;
      if (!live.has(name)) throw new SessionHostError('no-session', `${name} does not live.`);
      const attachment = fakeAttachment();
      attachments.push(attachment);
      return attachment;
    },
    async countAttached(name) {
      const held = nextCount;
      nextCount = undefined;
      if (held) await held.promise;
      return attached.get(name) ?? 0;
    },
    async kill(name) {
      const error = nextKillError;
      nextKillError = undefined;
      const held = nextKill;
      nextKill = undefined;
      if (held) await held.promise;
      if (error !== undefined) throw error;
      kills.push(name);
      return live.delete(name) ? 'killed' : 'gone';
    },
    shutDown: unused,
  };
}

/** The hook of a stub driver: its path names the events it tells, its body is ignored. */
export const STUB_EVENTS: Readonly<Record<string, readonly DriverEvent[]>> = {
  '/ready': [{ type: 'ready' }],
  '/prompt-taken': [{ type: 'prompt-taken' }],
  '/working': [{ type: 'working' }],
  '/turn-ended': [{ type: 'turn-ended', lastMessage: 'Done.' }],
  '/turn-ended-silently': [{ type: 'turn-ended' }],
  '/agent-exit': [{ type: 'ending', reason: 'agent-exit' }],
  '/ending': [{ type: 'ending', reason: 'lost' }],
  '/start-and-take': [{ type: 'ready' }, { type: 'prompt-taken' }],
  '/background': [],
  '/turn-ended-with-a-task': [
    { type: 'turn-ended', lastMessage: 'Done.' },
    { type: 'tasks', running: [{ id: 'a1', type: 'general-purpose' }] },
  ],
  '/task-finished': [{ type: 'task-finished', id: 'a1' }],
  '/compaction-began': [{ type: 'compaction-began' }],
  '/compaction-ended': [{ type: 'compaction-ended' }],
  '/turn-failed': [{ type: 'turn-failed', error: { kind: 'server', message: 'Overloaded.' } }],
  '/batch-ended': [{ type: 'batch-ended' }],
};

/**
 * The start of the path of a stub hook that asks a permission, held for
 * the app's answer: the call's reference follows it.
 */
export const ASK_PATH = '/ask:';

/**
 * The start of the path of a stub hook that tells a call finished: the
 * call's reference follows it.
 */
export const CALL_FINISHED_PATH = '/call-finished:';

/**
 * The start of the path of a stub hook that tells a call ran (`PostToolUse`):
 * the turn works, and the call finished; the call's reference follows it.
 */
export const TOOL_RAN_PATH = '/tool-ran:';

/**
 * The start of the path of a stub hook that tells a permission asked in
 * the terminal only: the call's reference follows it.
 */
export const ASKED_IN_TERMINAL_PATH = '/asked-in-terminal:';

/** The permission a stub driver reads asked about a call: a `Bash` command named after it. */
export function stubAsk(ref: string): AskOfCall {
  return {
    ref,
    content: { kind: 'permission', tool: 'Bash', input: { command: `touch ${ref}` } },
  };
}

/** What a stub hook whose path names a call tells: its ask, its end, or its ask in the terminal. */
function readCallHook(path: string): HookOutcome | undefined {
  if (path.startsWith(ASK_PATH)) return { events: [], ask: stubAsk(path.slice(ASK_PATH.length)) };
  if (path.startsWith(TOOL_RAN_PATH)) {
    const ref = path.slice(TOOL_RAN_PATH.length);
    return { events: [{ type: 'working' }, { type: 'call-finished', ref }] };
  }
  if (path.startsWith(CALL_FINISHED_PATH)) {
    return { events: [{ type: 'call-finished', ref: path.slice(CALL_FINISHED_PATH.length) }] };
  }
  if (path.startsWith(ASKED_IN_TERMINAL_PATH)) {
    const ask = stubAsk(path.slice(ASKED_IN_TERMINAL_PATH.length));
    return { events: [{ type: 'asked-in-terminal', ask }] };
  }
  return undefined;
}

/**
 * The start of the path of a stub hook that names the conversation the
 * agent works in: the id follows it.
 */
export const CONVERSATION_PATH = '/conversation/';

/**
 * The screens a stub driver reads: `input-box` (free to type into, and a
 * launch panel's close), `panel` (one it names `panel`), `unknown`, `dialog`
 * (one it does not know), `dialog:<name>`; any other text shows nothing.
 */
export function stubScreen(
  reading: 'input-box' | 'panel' | 'unknown' | 'dialog' | StartupDialog,
): string {
  return ['input-box', 'panel', 'unknown', 'dialog'].includes(reading)
    ? reading
    : `dialog:${reading}`;
}

/**
 * The start of the path of a stub hook that tells a prompt taken, with its
 * text: the text follows it.
 */
export const PROMPT_PATH = '/prompt:';

/** The start of a screen a stub driver reads as an input box holding a prompt an early Esc withdrew. */
const WITHDRAWN = 'withdrawn:';

/**
 * The screen a stub driver reads as the input box holding the prompt, put
 * back by an early Esc, with no sign that the agent works: its
 * `promptWithdrawn` for that prompt.
 */
export function withdrawnScreen(prompt: string): string {
  return `${WITHDRAWN}${prompt}`;
}

/** The input box a stub driver reads: on the `input-box` screen, empty; on a withdrawn one, the prompt. */
function readStubInputBox(text: string): InputBox | undefined {
  if (text.startsWith(WITHDRAWN)) return { text: text.slice(WITHDRAWN.length) };
  return text === 'input-box' ? { text: '' } : undefined;
}

/** Clears the input box as a stub driver does: one kill, the box taken for empty. */
export async function clearAsADriverDoes(terminal: ClearingTerminal): Promise<InputBoxClearing> {
  await terminal.pressKeys(['C-u']);
  return 'cleared';
}

/**
 * Types a prompt as a driver does, in a stub's few writes: a kill, the
 * text, Enter, then the wait for the agent to take it, and the restore.
 */
export async function typeAsADriverDoes(
  prompt: string,
  terminal: TypingTerminal,
): Promise<TypingOutcome> {
  await terminal.pressKeys(['C-u']);
  await terminal.typeText(prompt);
  await terminal.pressKeys(['Enter']);
  const taken = await terminal.promptTaken(prompt, TYPING_PATIENCE_MS);
  await terminal.pressKeys(['C-y']);
  return taken ? 'taken' : 'not-taken';
}

/** How long {@link typeAsADriverDoes} waits for the agent to take the prompt. */
export const TYPING_PATIENCE_MS = 3000;

function readStubScreen(text: string): ScreenReading {
  if (text === 'input-box' || text.startsWith(WITHDRAWN)) return { shows: 'input-box' };
  if (text === 'panel') return { shows: 'panel', panel: 'panel' };
  if (text === 'unknown') return { shows: 'unknown' };
  if (text === 'dialog') return { shows: 'dialog' };
  if (text.startsWith('dialog:')) {
    return { shows: 'dialog', dialog: text.slice('dialog:'.length) as StartupDialog };
  }
  return { shows: 'nothing' };
}

/**
 * A driver for tests: it launches what it is told, reads hooks by their
 * path alone and screens as {@link stubScreen} and {@link withdrawnScreen}
 * write them, and clears the input box with one kill.
 */
export interface StubDriver extends Driver {
  /** Every launch it was asked for, in order. */
  readonly launches: Launch[];
  /** Every conversation it was asked about, in order. */
  readonly resumeQuestions: Conversation[];
  /** Every conversation it follows, in order: what it reports, and whether it was stopped. */
  readonly follows: Following[];
  /** What `canResume` answers: a value, or an error it rejects with. */
  resumable: boolean | Error;
  /** Makes the next launch fail with the error. */
  failNextLaunch(error: unknown): void;
  /** Makes the next `canResume` wait until the test opens the gate it returns. */
  holdNextResume(): Gate;
}

/** A conversation a stub driver follows: the test reports for it. */
export interface Following {
  readonly conversation: FollowedConversation;
  /** Reports events of the agent's, as the driver would from outside its hooks. */
  readonly report: (events: readonly DriverEvent[]) => void;
  /** Whether the core stopped following it. */
  readonly stopped: boolean;
}

export const STUB_COMMAND: LaunchCommand = {
  command: 'stub-agent',
  args: ['--stub'],
  environment: { STUB_AGENT: 'yes' },
};

export function createStubDriver(): StubDriver {
  const launches: Launch[] = [];
  const resumeQuestions: Conversation[] = [];
  const follows: Following[] = [];
  let nextLaunchError: unknown;
  let nextResume: Gate | undefined;
  return {
    launches,
    resumeQuestions,
    follows,
    resumable: true,
    terminalKeys: [],
    silentStartCause: 'The stub agent sent no hook.',
    ...DRIVER_DEFAULTS,
    readScreen: readStubScreen,
    screenStateSigns: {
      ...DRIVER_DEFAULTS.screenStateSigns,
      launchPanelClosed: (text) => text === 'input-box',
      promptWithdrawn: (text, prompt) => text === withdrawnScreen(prompt),
    },
    readInputBox: readStubInputBox,
    typePrompt: typeAsADriverDoes,
    clearInputBox: clearAsADriverDoes,
    failNextLaunch(error) {
      nextLaunchError = error;
    },
    holdNextResume() {
      nextResume = gate();
      return nextResume;
    },
    async launch(launch) {
      launches.push(launch);
      const error = nextLaunchError;
      nextLaunchError = undefined;
      if (error !== undefined) throw error;
      return STUB_COMMAND;
    },
    readHook(request: HookRequest) {
      const conversationId = request.path.startsWith(CONVERSATION_PATH)
        ? request.path.slice(CONVERSATION_PATH.length)
        : undefined;
      if (conversationId !== undefined) {
        return { events: [{ type: 'conversation', conversationId }] };
      }
      if (request.path.startsWith(PROMPT_PATH)) {
        return {
          events: [{ type: 'prompt-taken', prompt: request.path.slice(PROMPT_PATH.length) }],
        };
      }
      return readCallHook(request.path) ?? { events: STUB_EVENTS[request.path] ?? [] };
    },
    follow(conversation, report) {
      const following = { conversation, report, stopped: false };
      follows.push(following);
      return () => {
        following.stopped = true;
      };
    },
    async canResume(conversation) {
      resumeQuestions.push(conversation);
      const held = nextResume;
      nextResume = undefined;
      if (held) await held.promise;
      if (this.resumable instanceof Error) throw this.resumable;
      return this.resumable;
    },
  };
}

/** Hook access that hands out a token per key and remembers what it revoked. */
export interface RecordingHookAccess extends HookAccess {
  readonly granted: string[];
  readonly revoked: string[];
}

export function createRecordingHookAccess(url = 'http://127.0.0.1:4000'): RecordingHookAccess {
  const granted: string[] = [];
  const revoked: string[] = [];
  return {
    granted,
    revoked,
    grant(key) {
      granted.push(key);
      return { url, token: `token-of-${key}` };
    },
    revoke: (key) => void revoked.push(key),
  };
}

/** Session folders under a fixed root, created and deleted nowhere. */
export function stubFolders(root = '/state/sessions'): SessionFolders {
  return { prepare: async (key) => `${root}/${key}`, remove: async () => undefined };
}

/** A record store in memory: what was put, read back as a copy, in the order keys were first put. */
export interface MemoryRecords extends RecordStore {
  /** How many records were put, in all. */
  readonly puts: number;
  /**
   * Holds every put asked from now on until released: each is kept by
   * `get` and `list` only then.
   *
   * @returns The release.
   */
  holdPuts(): () => void;
}

export function createMemoryRecords(initial: readonly UnitRecord[] = []): MemoryRecords {
  const records = new Map<string, UnitRecord>(initial.map((record) => [record.key, record]));
  let puts = 0;
  let held: Promise<void> | undefined;
  return {
    get puts() {
      return puts;
    },
    holdPuts() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        held = undefined;
        release();
      };
    },
    list: () => [...records.values()],
    get: (key) => records.get(key),
    async put(record) {
      puts += 1;
      const kept = structuredClone(record);
      await held;
      records.set(record.key, kept);
    },
    async remove(key) {
      records.delete(key);
    },
  };
}
