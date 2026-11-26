import type {
  Conversation,
  Driver,
  DriverEvent,
  HookRequest,
  Launch,
  LaunchCommand,
  ScreenReading,
} from '../../src/server/driver.ts';
import type {
  Attachment,
  SessionHost,
  StartOptions,
  TerminalSize,
} from '../../src/server/session-host/session-host.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import type { HookAccess, SessionFolders } from '../../src/server/sessions/sessions.ts';
import type { StartupDialog } from '../../src/shared/session.ts';
import { DRIVER_DEFAULTS } from './driver-defaults.ts';

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
}

export function createFakeHost(): FakeHost {
  const live = new Set<string>();
  const starts: StartOptions[] = [];
  const kills: string[] = [];
  const attachments: FakeAttachment[] = [];
  let listings = 0;
  let screenReads = 0;
  const screens = new Map<string, string>();
  const scrolled = new Set<string>();
  let nextStart: { error?: unknown; gate?: Gate } = {};
  let nextList: Gate | undefined;
  let listsFail = false;
  let nextKillError: unknown;
  let nextKill: Gate | undefined;
  let isLiveFails = false;
  let nextAttachError: unknown;
  const unused = () => Promise.reject(new Error('The sessions core does not use this.'));

  return {
    starts,
    kills,
    attachments,
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
    processOf: unused,
    sendText: unused,
    sendKeys: unused,
    sendBytes: unused,
    async readScreen(name) {
      screenReads += 1;
      if (!live.has(name)) throw new SessionHostError('no-session', `${name} does not live.`);
      return { text: screens.get(name) ?? '', inCopyMode: scrolled.has(name) };
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
    countAttached: unused,
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
};

/**
 * The screens a stub driver reads: `ready`, `dialog` (one it does not
 * know), `dialog:<name>`; any other text shows nothing.
 */
export function stubScreen(reading: 'ready' | 'dialog' | StartupDialog): string {
  return reading === 'ready' || reading === 'dialog' ? reading : `dialog:${reading}`;
}

function readStubScreen(text: string): ScreenReading {
  if (text === 'ready') return { shows: 'ready' };
  if (text === 'dialog') return { shows: 'dialog' };
  if (text.startsWith('dialog:')) {
    return { shows: 'dialog', dialog: text.slice('dialog:'.length) as StartupDialog };
  }
  return { shows: 'nothing' };
}

/**
 * A driver for tests: it launches what it is told, reads hooks by their
 * path alone and screens as {@link stubScreen} writes them.
 */
export interface StubDriver extends Driver {
  /** Every launch it was asked for, in order. */
  readonly launches: Launch[];
  /** Every conversation it was asked about, in order. */
  readonly resumeQuestions: Conversation[];
  /** What `canResume` answers: a value, or an error it rejects with. */
  resumable: boolean | Error;
  /** Makes the next launch fail with the error. */
  failNextLaunch(error: unknown): void;
}

export const STUB_COMMAND: LaunchCommand = {
  command: 'stub-agent',
  args: ['--stub'],
  environment: { STUB_AGENT: 'yes' },
};

export function createStubDriver(): StubDriver {
  const launches: Launch[] = [];
  const resumeQuestions: Conversation[] = [];
  let nextLaunchError: unknown;
  return {
    launches,
    resumeQuestions,
    resumable: true,
    terminalKeys: [],
    silentStartCause: 'The stub agent sent no hook.',
    ...DRIVER_DEFAULTS,
    readScreen: readStubScreen,
    failNextLaunch(error) {
      nextLaunchError = error;
    },
    async launch(launch) {
      launches.push(launch);
      const error = nextLaunchError;
      nextLaunchError = undefined;
      if (error !== undefined) throw error;
      return STUB_COMMAND;
    },
    readHook(request: HookRequest) {
      return { events: STUB_EVENTS[request.path] ?? [] };
    },
    async canResume(conversation) {
      resumeQuestions.push(conversation);
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

/** Session folders under a fixed root, created nowhere. */
export function stubFolders(root = '/state/sessions'): SessionFolders {
  return { prepare: async (key) => `${root}/${key}` };
}
