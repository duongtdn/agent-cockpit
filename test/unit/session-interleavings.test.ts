/**
 * Random interleavings of what an app, its agents, a person and time do to
 * the sessions, against the sessions core and the units of work on their
 * test doubles, with fake timers. Whatever the order, once time has passed
 * every bound and every agent has exited: no session is left between two
 * phases, every call settled, each session's end was told once, nothing
 * was typed into a session after the cockpit asked it to end, no key
 * pressed into it once an end was asked but that end's interrupt's (no
 * withdrawn prompt cleared, no first prompt typed), no
 * interrupt, an end's own among them, pressed its keys twice, nor resolved
 * `interrupted` on a session not `idle`, a key removed and not run since
 * is unknown, with no record, and nothing of a removed record — its
 * conversations, its history — comes back into the key's record when it
 * is run again, and no session was ended for idleness while a terminal
 * was attached to it, a background task ran in it, or it was not `idle`
 * since the timeout or longer, as its end began. The agent's asks: each
 * settled once and told once, a session `waiting` exactly while it lists
 * an ask still pending (and listing every one), no hook held once its ask
 * settled or its session ended, and every answer resolved or refused for
 * a reason the app is told.
 *
 * A failure prints its seed, its path and the shrunk sequence with its
 * `replayPath`; run it again with `INTERLEAVINGS_SEED`, `INTERLEAVINGS_PATH`
 * and `INTERLEAVINGS_REPLAY_PATH` set to them.
 * A feature that adds an event adds its command to {@link COMMANDS}.
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asks } from '../../src/server/asks/asks.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import type { JobRuns } from '../../src/server/sessions/job-runs.ts';
import {
  createSessions,
  INPUT_BOX_BOUND_MS,
  LIVENESS_INTERVAL_MS,
  PROMPT_BOUND_MS,
  type Sessions,
  SessionsClosedError,
} from '../../src/server/sessions/sessions.ts';
import { START_DEADLINE_MS } from '../../src/server/sessions/start-up-watch.ts';
import { openUnitsOfWork, type UnitsOfWork } from '../../src/server/sessions/units-of-work.ts';
import type { UnitRecord } from '../../src/server/state/records.ts';
import { createTerminalHolds } from '../../src/server/terminal-hold.ts';
import type { Ask } from '../../src/shared/ask.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import type { Session } from '../../src/shared/session.ts';
import { DRIVER_DEFAULTS } from '../support/driver-defaults.ts';
import {
  ASK_PATH,
  ASKED_IN_TERMINAL_PATH,
  CALL_FINISHED_PATH,
  createFakeHolds,
  createFakeHost,
  createMemoryRecords,
  createRecordingHookAccess,
  createStubDriver,
  createTestAsks,
  type FakeHeldHook,
  type FakeHolds,
  type FakeHost,
  type MemoryRecords,
  PROMPT_PATH,
  type StubDriver,
  stubFolders,
  stubScreen,
  TYPING_PATIENCE_MS,
  withdrawnScreen,
} from '../support/sessions-doubles.ts';

const T0 = new Date('2026-11-27T10:00:00.000Z');
const APP = '/apps/demo';
const FILES = ['a', 'b', 'c'] as const;
type File = (typeof FILES)[number];
const KEYS = FILES.map(keyOf);
/** A prompt longer than the stub's command line takes: typed once the agent is ready. */
const LONG_PROMPT = `Explain everything, at length: ${'every part. '.repeat(4)}`;
/** The longest prompt the stub driver passes on the command line. */
const COMMAND_LINE_LIMIT = 40;
/** Longer than any bound of the core, of the driver's end, and of the stub's typing. */
const PAST_EVERY_BOUND_MS =
  START_DEADLINE_MS +
  INPUT_BOX_BOUND_MS +
  PROMPT_BOUND_MS +
  TYPING_PATIENCE_MS +
  DRIVER_DEFAULTS.ending.boundMs +
  DRIVER_DEFAULTS.interrupting.boundMs +
  2 * LIVENESS_INTERVAL_MS;
/** How long the drain lets time pass: every bound, for each of a few launches queued one after another. */
const DRAIN_MS = 3 * PAST_EVERY_BOUND_MS;
/** How often the drain makes every agent exit: within the liveness watch's interval. */
const DRAIN_STEP_MS = LIVENESS_INTERVAL_MS / 2;

/** The stub driver's interrupt keys, as a write of them reads. */
const INTERRUPT_KEYS = DRIVER_DEFAULTS.interrupting.busy.keys.join(' ');

/** Waits on the fake clock: a double's call that takes time. */
function elapsed(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function keyOf(file: File): string {
  return `explain-${file}`;
}

/**
 * What a run's options vary: the cap, the idle timeout, whether an agent
 * exits when it is signalled, whether an Esc puts the prompt back into the
 * input box, as an agent that had not begun on it does, and how long the
 * host takes to kill a
 * session or count its terminals, and the driver to tell whether a
 * conversation can resume.
 */
interface Setting {
  readonly maxSessions: number | undefined;
  readonly idleTimeoutMs: number | undefined;
  readonly exitOnSignal: boolean;
  readonly escWithdraws: boolean;
  readonly slowness: Slowness;
}

/** How long a call to a double takes, in milliseconds of the fake clock. */
interface Slowness {
  readonly kill: number;
  readonly count: number;
  readonly resume: number;
}

/** Nothing is modelled: the properties are checked on the real core once the commands ran. */
type Model = object;

/** A call made of the core or the units of work, and whether it settled. */
interface Call {
  readonly label: string;
  settled: boolean;
  /** What it rejected with, when it did. */
  failure?: unknown;
}

/** Why an answer may be refused: each a refusal the app is told. */
const ANSWER_REFUSALS: readonly string[] = [
  'unknown-id',
  'already-settled',
  'terminal-only',
  'invalid-answer',
];

/** The answers an app gives: each kind of answer, one that fits no ask, and one to an id never opened. */
type AnswerGiven = 'allow' | 'remember' | 'deny' | 'invalid' | 'unknown-id';

const ANSWERS: Readonly<Record<Exclude<AnswerGiven, 'unknown-id'>, unknown>> = {
  allow: { allow: true },
  remember: { allow: true, remember: 'session' },
  deny: { allow: false, message: 'Not that.' },
  invalid: { allow: 'yes' },
};

/** The call a stub ask is about, as its content names it. */
function refOf(ask: Ask): string {
  return String(ask.input.command).replace(/^touch /, '');
}

/** The core and the units of work on their doubles, and what the properties look at. */
class World {
  readonly host: FakeHost = createFakeHost();
  readonly asks: Asks = createTestAsks();
  readonly holds: FakeHolds = createFakeHolds();
  /** Each breach of the asks' properties, as it was seen: `<what> <id or key>`. */
  readonly askBreaches: string[] = [];
  /** The id of each ask opened, by the call it is about. */
  readonly #askOfCall = new Map<string, string>();
  /** How many times each ask opened was told settled. */
  readonly #settledTold = new Map<string, number>();
  /** The calls each key's agent asked about, in order. */
  readonly #calls = new Map<string, string[]>();
  /** The call each held hook is about. */
  readonly #callOfHeld = new Map<FakeHeldHook, string>();
  readonly sessions: Sessions;
  readonly calls: Call[] = [];
  /** Each key whose end was told again without a launch between. */
  readonly endsToldTwice: string[] = [];
  /** Each write into a session whose end was under way: `<key> <write>`. */
  readonly writesAfterEnd: string[] = [];
  /**
   * Each write into a session while an end asked of the core runs, but
   * its interrupt's keys: `<key> <write>`.
   */
  readonly writesAfterEndAsked: string[] = [];
  /** The last prompt passed to each key's session, which its hook tells taken. */
  readonly lastPrompt = new Map<string, string>();
  /**
   * Each press of the interrupt's keys that its interrupt had pressed
   * already, or that no interrupt pressed: `<key> <keys>`.
   */
  readonly keysPressedAgain: string[] = [];
  /** Each key of an interrupt that resolved `interrupted` though no change made its session `idle` while it ran. */
  readonly interruptedNotIdle: string[] = [];
  /**
   * Each end for idleness begun on a session that was not `idle` since the
   * timeout or longer, or had a terminal attached or a background task
   * running: `<key> <why>`.
   */
  readonly idleEndsOfHeld: string[] = [];
  /** How many terminals are attached to each key's session, as the host counts them. */
  readonly #attached = new Map<string, number>();
  readonly records: MemoryRecords = createMemoryRecords();
  units: UnitsOfWork | undefined;
  closed = false;
  /** The keys whose agent the cockpit asked to end or killed, until their next start. */
  readonly #ending = new Set<string>();
  readonly #lastSeen = new Map<string, Session>();
  readonly #driver: StubDriver = createStubDriver();
  /** How many ends asked of the core run on each key, its own and its cap's or idle timeout's. */
  readonly #endsAsked = new Map<string, number>();
  /** The keys whose interrupt runs in the core, with how many times it pressed the interrupt's keys. */
  readonly #interrupting = new Map<string, number>();
  /** The keys whose interrupt runs in the core and saw a change of its session to `idle`. */
  readonly #idleSeen = new Set<string>();
  /**
   * Each key whose last run or remove asked was a remove, with whether it
   * resolved, `removed` or with nothing to remove: no run asked before it
   * can record the key after it.
   */
  readonly #removals = new Map<string, { resolved: boolean }>();
  /** The conversations of every record removed, by key: those its current one, earlier ones and history name. */
  readonly #removedConversations = new Map<string, Set<string>>();

  readonly #idleTimeoutMs: number | undefined;

  constructor({ exitOnSignal, escWithdraws, slowness, idleTimeoutMs }: Setting) {
    this.#idleTimeoutMs = idleTimeoutMs;
    const driver = this.#driver;
    driver.promptFitsLaunch = (prompt) => prompt.length <= COMMAND_LINE_LIMIT;
    const canResume = driver.canResume.bind(driver);
    driver.canResume = async (conversation) => {
      await elapsed(slowness.resume);
      return canResume(conversation);
    };
    this.#watchTheHost(slowness, escWithdraws);
    this.#watchTheRemovals();
    // An agent draws its input box unless a command shows another screen.
    for (const key of KEYS) this.show(key, 'input-box');
    this.sessions = createSessions({
      host: this.host,
      driver,
      hooks: createRecordingHookAccess(),
      folders: stubFolders(),
      environment: () => ({ PATH: '/usr/bin' }),
      admitAgent: async () => {},
      confinement: async () => ({
        stateRoots: ['/state'],
        appAddresses: [],
        listener: { host: '127.0.0.1', port: 4000 },
      }),
      holds: createTerminalHolds(),
      asks: this.asks,
      signal: (pid) => {
        const key = KEYS.find((each) => this.host.pidOf(each) === pid);
        if (key === undefined) return;
        this.#ending.add(key);
        if (exitOnSignal) this.host.exit(key);
      },
    });
    this.sessions.follow((list) => {
      this.#seeEnds(list);
      this.#seeIdles(list);
    });
    this.#watchTheAsks();
    this.#watchTheInterrupts();
    this.#watchTheIdleEnds();
    this.#watchTheEndsAsked();
  }

  async open({ maxSessions, idleTimeoutMs }: Setting): Promise<void> {
    this.units = await openUnitsOfWork({
      sessions: this.sessions,
      records: this.records,
      jobs: JOBS,
      driver: { launchSettings: () => ({}), canResume: async () => true },
      environment: () => ({ PATH: '/usr/bin' }),
      folders: stubFolders(),
      ...(maxSessions === undefined ? {} : { maxSessions }),
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    });
  }

  /** A time just past the idle timeout: 1 ms when there is none. */
  get pastTheIdleTimeoutMs(): number {
    return (this.#idleTimeoutMs ?? 0) + 1;
  }

  /** Attaches terminals to a key's session, or detaches them, as a page or a person does. */
  attach(key: string, count: number): void {
    this.#attached.set(key, count);
    this.host.attachTerminals(key, count);
  }

  get unitsOfWork(): UnitsOfWork {
    if (this.units === undefined) throw new Error('The units of work are not open.');
    return this.units;
  }

  /**
   * Shows a screen in a session: its input box, a start-up dialog, the
   * last prompt passed withdrawn into the box by an early Esc, or nothing
   * yet.
   */
  show(key: string, screen: 'input-box' | 'dialog' | 'withdrawn' | 'blank'): void {
    if (screen === 'blank') this.host.show(key, '');
    else if (screen === 'withdrawn') {
      this.host.show(key, withdrawnScreen(this.lastPrompt.get(key) ?? ''));
    } else this.host.show(key, stubScreen(screen === 'dialog' ? 'onboarding' : 'input-box'));
  }

  /** Makes the transcript of the key's session record an interruption, as the driver reports it. */
  recordInterruption(key: string): void {
    const conversationId = this.sessions.conversationOf(key);
    const following = this.#driver.follows.findLast(
      (each) => !each.stopped && each.conversation.conversationId === conversationId,
    );
    following?.report([{ type: 'interrupted' }]);
  }

  /** Makes a call, kept to see whether it settles. */
  call(label: string, promise: Promise<unknown>): void {
    const call: Call = { label, settled: false };
    this.calls.push(call);
    promise.then(
      () => {
        call.settled = true;
      },
      (failure: unknown) => {
        call.settled = true;
        call.failure = failure;
      },
    );
  }

  /** Runs a job, as the app asks. */
  run(job: string, file: File, fresh: boolean): void {
    this.#removals.delete(keyOf(file));
    this.call(`run ${job} ${file}`, this.unitsOfWork.run(job, { file }, { fresh }));
  }

  /** Removes a unit of work, as the app asks. */
  remove(key: string): void {
    const removal = { resolved: false };
    this.#removals.set(key, removal);
    const removing = this.unitsOfWork.remove(key).then(() => {
      removal.resolved = true;
    });
    this.call(`remove ${key}`, removing);
  }

  /** Each conversation of a removed record that the key's record names again: `<key> <conversation>`. */
  removedConversationsKept(): string[] {
    return [...this.#removedConversations].flatMap(([key, removed]) => {
      const record = this.records.get(key);
      if (record === undefined) return [];
      return conversationsOf(record)
        .filter((conversationId) => removed.has(conversationId))
        .map((conversationId) => `${key} ${conversationId}`);
    });
  }

  /** The keys removed and not run since that are still listed, or still recorded. */
  removedButKnown(): string[] {
    const listed = new Set(this.unitsOfWork.list().map((session) => session.key));
    return [...this.#removals]
      .filter(([key, { resolved }]) => resolved && (listed.has(key) || this.records.get(key)))
      .map(([key]) => key);
  }

  unsettled(): string[] {
    return this.calls.filter((call) => !call.settled).map((call) => call.label);
  }

  /** The calls that failed with anything but what an app is told: a fault of the cockpit's. */
  faults(): string[] {
    return this.calls
      .filter(({ failure }) => failure !== undefined && !isToldToTheApp(failure))
      .map(({ label, failure }) => `${label}: ${String(failure)}`);
  }

  close(): void {
    this.closed = true;
    this.call('close', this.unitsOfWork.close());
    this.sessions.close();
  }

  /**
   * Lets time pass every bound a few times over, every agent exiting as
   * soon as it starts: the operations still queued on a key, each of which
   * may launch its session again, run out too.
   */
  async drain(): Promise<void> {
    for (let waited = 0; waited < DRAIN_MS; waited += DRAIN_STEP_MS) {
      for (const key of KEYS) this.host.exit(key);
      await vi.advanceTimersByTimeAsync(DRAIN_STEP_MS);
    }
  }

  /** The agent asks a permission about a new call, held, or in its terminal only. */
  ask(key: string, inTerminal: boolean): void {
    const call = `call-${[...this.#calls.values()].flat().length + 1}`;
    this.#calls.set(key, [...(this.#calls.get(key) ?? []), call]);
    const held = this.holds.held.length;
    this.receive(key, `${inTerminal ? ASKED_IN_TERMINAL_PATH : ASK_PATH}${call}`);
    const hook = this.holds.held[held];
    if (hook !== undefined) this.#callOfHeld.set(hook, call);
  }

  /**
   * A person answers Yes in the terminal: the oldest call of the key whose
   * ask is pending finishes (or its last call, its ask settled already).
   */
  finishCall(key: string): void {
    const calls = this.#calls.get(key) ?? [];
    const pending = new Set(this.asks.pending(key).map((ask) => ask.id));
    const call = calls.find((each) => pending.has(this.#askOfCall.get(each) ?? '')) ?? calls.at(-1);
    if (call !== undefined) this.receive(key, `${CALL_FINISHED_PATH}${call}`);
  }

  /** A person answers a plain "No" in the terminal: the agent closes the oldest hook of the key it holds open. */
  closeHeld(key: string): void {
    const calls = new Set(this.#calls.get(key));
    const hook = this.holds.held.find(
      (each) => each.end === 'open' && calls.has(this.#callOfHeld.get(each) ?? ''),
    );
    hook?.closeByAgent();
  }

  /** The app answers the oldest pending ask of the key (or the last it opened, or an id never opened). */
  answer(key: string, given: AnswerGiven): void {
    const opened = (this.#calls.get(key) ?? []).flatMap((call) => this.#askOfCall.get(call) ?? []);
    const id =
      given === 'unknown-id'
        ? 'no-such-ask'
        : (this.asks.pending(key)[0]?.id ?? opened.at(-1) ?? 'no-such-ask');
    const answer = given === 'unknown-id' ? ANSWERS.allow : ANSWERS[given];
    this.asks.answer(id, answer).catch((refused: unknown) => {
      if (refused instanceof CockpitError && ANSWER_REFUSALS.includes(refused.code)) return;
      this.askBreaches.push(`answer ${id} failed: ${String(refused)}`);
    });
  }

  /** Sends a hook of a key's agent, held when the core holds it. */
  receive(key: string, path: string): void {
    this.sessions.receive({ key, path, body: {} }, this.holds.hold);
  }

  /**
   * Checks the asks against the sessions once a command ran: each session
   * lists exactly its asks pending, in the order they opened, and no hook is
   * held for an ask settled or a session ended. After the close neither
   * the core nor the hooks move again.
   */
  checkTheAsks(): void {
    if (this.closed) return;
    for (const key of KEYS) {
      const session = this.sessions.session(key);
      const listed =
        session?.state === 'waiting' ? session.pending.flatMap((each) => each.id ?? []) : [];
      const pending = this.asks.pending(key).map((ask) => ask.id);
      if (listed.join() !== pending.join()) {
        this.askBreaches.push(`${key} lists [${listed}] with [${pending}] pending`);
      }
    }
    const pending = new Set(this.asks.pending('*').map((ask) => ask.id));
    for (const [hook, call] of this.#callOfHeld) {
      if (hook.end !== 'open') continue;
      const id = this.#askOfCall.get(call) ?? call;
      if (!pending.has(id)) this.askBreaches.push(`held after settled ${id}`);
    }
  }

  /** Checks, once every agent exited, that every ask opened was told settled exactly once. */
  checkEveryAskSettled(): void {
    for (const id of this.#askOfCall.values()) {
      const told = this.#settledTold.get(id) ?? 0;
      if (told !== 1) this.askBreaches.push(`told ${told} times ${id}`);
    }
  }

  #watchTheAsks(): void {
    this.asks.follow('*', (ask) => void this.#askOfCall.set(refOf(ask), ask.id));
    this.asks.on('settled', ({ id }) => {
      const told = (this.#settledTold.get(id) ?? 0) + 1;
      this.#settledTold.set(id, told);
      if (told > 1) this.askBreaches.push(`told again ${id}`);
    });
  }

  /** Keeps the conversations of each record as it is removed. */
  #watchTheRemovals(): void {
    const { records } = this;
    const remove = records.remove.bind(records);
    records.remove = async (key) => {
      const record = records.get(key);
      if (record !== undefined) {
        const removed = this.#removedConversations.get(key) ?? new Set();
        for (const conversationId of conversationsOf(record)) removed.add(conversationId);
        this.#removedConversations.set(key, removed);
      }
      await remove(key);
    };
  }

  /** Marks the ends the cockpit asks of the host, and the writes it makes. */
  #watchTheHost(slowness: Slowness, escWithdraws: boolean): void {
    const { host } = this;
    const start = host.start.bind(host);
    host.start = async (options) => {
      this.#ending.delete(options.name);
      await start(options);
    };
    const kill = host.kill.bind(host);
    host.kill = async (name) => {
      this.#ending.add(name);
      await elapsed(slowness.kill);
      return kill(name);
    };
    const countAttached = host.countAttached.bind(host);
    host.countAttached = async (name) => {
      await elapsed(slowness.count);
      return countAttached(name);
    };
    const sendText = host.sendText.bind(host);
    host.sendText = async (name, text, pacing) => {
      this.#write(name, `text:${text}`);
      await sendText(name, text, pacing);
    };
    const sendKeys = host.sendKeys.bind(host);
    host.sendKeys = async (name, keys) => {
      const write = keys.join(' ');
      this.#write(name, write);
      await sendKeys(name, keys);
      if (escWithdraws && write === INTERRUPT_KEYS) this.show(name, 'withdrawn');
    };
  }

  /**
   * Marks each interrupt the core runs, from its start until it settled,
   * and each end that may interrupt first: the keys an end presses are its
   * interrupt's.
   */
  #watchTheInterrupts(): void {
    const interruptAndEnd = this.sessions.interruptAndEnd.bind(this.sessions);
    this.sessions.interruptAndEnd = (key, reason) =>
      this.#whileInterrupting(key, () => interruptAndEnd(key, reason));
    const interrupt = this.sessions.interrupt.bind(this.sessions);
    this.sessions.interrupt = (key) =>
      this.#whileInterrupting(key, async () => {
        this.#idleSeen.delete(key);
        const result = await interrupt(key);
        if (result.action === 'interrupted' && !this.#idleSeen.has(key)) {
          this.interruptedNotIdle.push(key);
        }
        return result;
      });
  }

  /** Marks each end for idleness begun on a session that something held, or too soon, as the end begins. */
  #watchTheIdleEnds(): void {
    const end = this.sessions.end.bind(this.sessions);
    this.sessions.end = (key, reason) => {
      if (reason === 'idle-timeout') {
        const session = this.sessions.session(key);
        if (session?.state !== 'idle') this.idleEndsOfHeld.push(`${key} ${session?.state}`);
        else if (session.backgroundTasks !== undefined) this.idleEndsOfHeld.push(`${key} tasks`);
        else if (Date.now() - Date.parse(session.since) < (this.#idleTimeoutMs ?? 0)) {
          this.idleEndsOfHeld.push(`${key} idle since ${session.since}`);
        }
        if ((this.#attached.get(key) ?? 0) > 0) this.idleEndsOfHeld.push(`${key} attached`);
      }
      return end(key, reason);
    };
  }

  /** Marks each end asked of the core, from its call until it settled. */
  #watchTheEndsAsked(): void {
    const interruptAndEnd = this.sessions.interruptAndEnd.bind(this.sessions);
    this.sessions.interruptAndEnd = (key, reason) =>
      this.#whileEnding(key, () => interruptAndEnd(key, reason));
    const end = this.sessions.end.bind(this.sessions);
    this.sessions.end = (key, reason) => this.#whileEnding(key, () => end(key, reason));
  }

  async #whileEnding<T>(key: string, run: () => Promise<T>): Promise<T> {
    this.#endsAsked.set(key, (this.#endsAsked.get(key) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const left = (this.#endsAsked.get(key) ?? 1) - 1;
      if (left === 0) this.#endsAsked.delete(key);
      else this.#endsAsked.set(key, left);
    }
  }

  /**
   * Counts the interrupt's keys pressed while it runs: an end's whole run,
   * its interrupt's inside it, is one mark.
   */
  async #whileInterrupting<T>(key: string, run: () => Promise<T>): Promise<T> {
    const outermost = !this.#interrupting.has(key);
    if (outermost) this.#interrupting.set(key, 0);
    try {
      return await run();
    } finally {
      if (outermost) this.#interrupting.delete(key);
    }
  }

  #write(key: string, write: string): void {
    if (write === INTERRUPT_KEYS) this.#pressedToInterrupt(key, write);
    // A write to a session gone is refused by the host: nothing reaches an agent.
    if (this.host.pidOf(key) === undefined) return;
    if (this.#ending.has(key)) this.writesAfterEnd.push(`${key} ${write}`);
    else if (this.#endsAsked.has(key) && write !== INTERRUPT_KEYS) {
      this.writesAfterEndAsked.push(`${key} ${write}`);
    }
  }

  #pressedToInterrupt(key: string, keys: string): void {
    const pressed = this.#interrupting.get(key);
    if (pressed !== 0) this.keysPressedAgain.push(`${key} ${keys}`);
    if (pressed !== undefined) this.#interrupting.set(key, pressed + 1);
  }

  #seeIdles(list: readonly Session[]): void {
    for (const { key, state } of list) {
      if (state === 'idle' && this.#interrupting.has(key)) this.#idleSeen.add(key);
    }
  }

  #seeEnds(list: readonly Session[]): void {
    for (const session of list) {
      const before = this.#lastSeen.get(session.key);
      if (before?.state === 'ended' && session.state === 'ended' && before !== session) {
        this.endsToldTwice.push(session.key);
      }
      this.#lastSeen.set(session.key, session);
    }
  }
}

/** Every conversation a record names: its current one, its earlier ones, its history's. */
function conversationsOf(record: UnitRecord): string[] {
  return [
    record.conversationId,
    ...record.earlierConversations,
    ...record.history.map((entry) => entry.conversationId),
  ];
}

/** Whether an error is one a call tells the app: a refusal, the close, the host's failure. */
function isToldToTheApp(error: unknown): boolean {
  return (
    error instanceof CockpitError ||
    error instanceof SessionsClosedError ||
    error instanceof SessionHostError
  );
}

/** The app's jobs: `explain` passes its prompt on the command line, `long` types it once the agent is ready. */
const JOBS: JobRuns = {
  read(jobId, args) {
    const { file } = args as { file: File };
    const prompt = jobId === 'long' ? LONG_PROMPT : `Explain ${file}.`;
    const run = {
      jobId,
      key: keyOf(file),
      prompt,
      args,
      folder: { path: APP, relative: '.' },
      fresh: false,
    };
    return { key: run.key, prompt, checked: async () => run };
  },
  makeFolder: async (folder) => folder,
  recordedFolder: async (relative) => ({ path: APP, relative }),
};

type Command = fc.AsyncCommand<Model, World>;

/** A command that does something to the world, then lets every promise it began move on. */
function command(label: string, act: (world: World) => unknown): Command {
  return {
    check: () => true,
    async run(_model, world) {
      await act(world);
      await vi.advanceTimersByTimeAsync(0);
      world.checkTheAsks();
    },
    toString: () => label,
  };
}

const file = fc.constantFrom(...FILES);
const fresh = fc.boolean();

/**
 * What may happen, one arbitrary per kind of event, weighted by how often
 * it comes: a later feature adds its own here.
 */
const COMMANDS: fc.WeightedArbitrary<Command>[] = [
  {
    weight: 4,
    arbitrary: fc.tuple(fc.constantFrom('explain', 'long'), file, fresh).map(([job, file, fresh]) =>
      command(`run ${job} ${file}${fresh ? ' fresh' : ''}`, (world) => {
        world.lastPrompt.set(keyOf(file), job === 'long' ? LONG_PROMPT : `Explain ${file}.`);
        world.run(job, file, fresh);
      }),
    ),
  },
  {
    weight: 3,
    arbitrary: fc.tuple(file, fc.constantFrom('Hello.', LONG_PROMPT)).map(([file, prompt]) =>
      command(`send ${file} ${prompt.length}`, (world) => {
        world.lastPrompt.set(keyOf(file), prompt);
        world.call(`send ${file}`, world.unitsOfWork.send(keyOf(file), prompt));
      }),
    ),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(file, fresh)
      .map(([file, fresh]) =>
        command(`open ${file}${fresh ? ' fresh' : ''}`, (world) =>
          world.call(`open ${file}`, world.unitsOfWork.open(keyOf(file), { fresh })),
        ),
      ),
  },
  {
    weight: 2,
    arbitrary: file.map((file) =>
      command(`interrupt ${file}`, (world) =>
        world.call(`interrupt ${file}`, world.unitsOfWork.interrupt(keyOf(file))),
      ),
    ),
  },
  {
    weight: 2,
    arbitrary: file.map((file) =>
      command(`marker ${file}`, (world) => world.recordInterruption(keyOf(file))),
    ),
  },
  {
    weight: 2,
    arbitrary: file.map((file) =>
      command(`end ${file}`, (world) =>
        world.call(`end ${file}`, world.sessions.end(keyOf(file), 'app')),
      ),
    ),
  },
  {
    weight: 2,
    arbitrary: file.map((file) =>
      command(`end-unit ${file}`, (world) =>
        world.call(`end-unit ${file}`, world.unitsOfWork.end(keyOf(file))),
      ),
    ),
  },
  {
    weight: 2,
    arbitrary: file.map((file) => command(`remove ${file}`, (world) => world.remove(keyOf(file)))),
  },
  { weight: 1, arbitrary: fc.constant(command('close', (world) => world.close())) },
  {
    weight: 8,
    arbitrary: fc
      .tuple(
        file,
        fc.constantFrom(
          'ready',
          'start-and-take',
          'prompt',
          'working',
          'turn-ended',
          'turn-ended-with-a-task',
          'task-finished',
        ),
      )
      .map(([file, hook]) =>
        command(`hook ${file} ${hook}`, (world) => {
          const key = keyOf(file);
          const prompt = world.lastPrompt.get(key) ?? '';
          const path = hook === 'prompt' ? `${PROMPT_PATH}${prompt}` : `/${hook}`;
          world.receive(key, path);
        }),
      ),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        file,
        fc.constantFrom(
          'asked',
          'asked-in-terminal',
          'yes',
          'yes-failing',
          'plain-no',
          'amended-no',
        ),
      )
      .map(([file, act]) =>
        command(`ask ${file} ${act}`, (world) => {
          const key = keyOf(file);
          if (act === 'asked' || act === 'asked-in-terminal') {
            world.ask(key, act === 'asked-in-terminal');
          }
          // A tool that fails after a Yes ends its call as one that ran: the driver tells both `call-finished`.
          else if (act === 'yes' || act === 'yes-failing') world.finishCall(key);
          else if (act === 'plain-no') world.closeHeld(key);
          else world.receive(key, '/batch-ended');
        }),
      ),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        file,
        fc.constantFrom<AnswerGiven>('allow', 'remember', 'deny', 'invalid', 'unknown-id'),
      )
      .map(([file, given]) =>
        command(`answer ${file} ${given}`, (world) => world.answer(keyOf(file), given)),
      ),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(file, fc.constantFrom('input-box', 'dialog', 'withdrawn', 'blank'))
      .map(([file, screen]) =>
        command(`screen ${file} ${screen}`, (world) => world.show(keyOf(file), screen)),
      ),
  },
  {
    weight: 2,
    arbitrary: file.map((file) => command(`gone ${file}`, (world) => world.host.exit(keyOf(file)))),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(file, fc.constantFrom(0, 1))
      .map(([file, count]) =>
        command(`attach ${file} ${count}`, (world) => world.attach(keyOf(file), count)),
      ),
  },
  {
    weight: 2,
    arbitrary: fc.constant(
      command('tick past the idle timeout', (world) =>
        vi.advanceTimersByTimeAsync(world.pastTheIdleTimeoutMs),
      ),
    ),
  },
  {
    weight: 4,
    arbitrary: fc
      .constantFrom(
        200,
        LIVENESS_INTERVAL_MS,
        TYPING_PATIENCE_MS,
        INPUT_BOX_BOUND_MS,
        START_DEADLINE_MS,
      )
      .map((ms) => command(`tick ${ms}`, () => vi.advanceTimersByTimeAsync(ms))),
  },
];

const delay = fc.constantFrom(0, 300, LIVENESS_INTERVAL_MS + 500);
const setting: fc.Arbitrary<Setting> = fc.record({
  maxSessions: fc.constantFrom(undefined, 1, 2),
  idleTimeoutMs: fc.constantFrom(undefined, 500, 3_000),
  exitOnSignal: fc.boolean(),
  escWithdraws: fc.boolean(),
  slowness: fc.record({ kill: delay, count: delay, resume: delay }),
});

/** How many sequences a run of the suite tries: a fraction of a second on a laptop. */
const RUNS = 300;

/** The seed, path and commands' path of a failure to replay, as its report gives them. */
function replay(): { parameters: fc.Parameters<unknown>; replayPath?: string } {
  const {
    INTERLEAVINGS_SEED: seed,
    INTERLEAVINGS_PATH: path,
    INTERLEAVINGS_REPLAY_PATH: replayPath,
  } = process.env;
  return {
    parameters: {
      numRuns: RUNS,
      ...(seed === undefined ? {} : { seed: Number(seed) }),
      ...(path === undefined ? {} : { path }),
    },
    ...(replayPath === undefined ? {} : { replayPath }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the sessions, whatever the order of what happens to them', () => {
  it('leave no session between two phases, every call settled, each end told once, nothing typed into a session being ended, no interrupt pressing twice or resolved on a session not idle, no removed key known nor its record come back, no session held ended for idleness, every ask settled and told once, a session waiting exactly on its pending asks, no hook held past its ask', async () => {
    const { parameters, replayPath } = replay();
    await fc.assert(
      fc.asyncProperty(
        setting,
        fc.commands([fc.oneof(...COMMANDS)], {
          size: 'medium',
          ...(replayPath === undefined ? {} : { replayPath }),
        }),
        async (setting, commands) => {
          vi.useFakeTimers({ now: T0 });
          const world = new World(setting);
          try {
            await world.open(setting);
            await fc.asyncModelRun(() => ({ model: {}, real: world }), commands);
            await world.drain();

            expect(world.unsettled()).toEqual([]);
            expect(world.faults()).toEqual([]);
            expect(world.endsToldTwice).toEqual([]);
            expect(world.writesAfterEnd).toEqual([]);
            expect(world.writesAfterEndAsked).toEqual([]);
            expect(world.keysPressedAgain).toEqual([]);
            expect(world.interruptedNotIdle).toEqual([]);
            expect(world.removedButKnown()).toEqual([]);
            expect(world.removedConversationsKept()).toEqual([]);
            expect(world.idleEndsOfHeld).toEqual([]);
            if (!world.closed) world.checkEveryAskSettled();
            expect(world.askBreaches).toEqual([]);
            if (!world.closed) {
              expect(world.sessions.liveKeys()).toEqual([]);
              const notEnded = world.sessions.list().filter((each) => each.state !== 'ended');
              expect(notEnded).toEqual([]);
            }
          } finally {
            if (!world.closed) world.close();
            vi.useRealTimers();
          }
        },
      ),
      parameters,
    );
  });
});
