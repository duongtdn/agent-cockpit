/**
 * The sessions core: the registry of the cockpit's sessions by key, their
 * states as the driver's events and the host tell them, their launches,
 * the prompts typed into them and their ends, and the list an app and the
 * browser follow. It speaks to tmux only through the session host, and to
 * the agent only through the driver. What a run, a send or an open does
 * in each state is the units of work's (`units-of-work.ts`), on top of it.
 *
 * @packageDocumentation
 */

import { CockpitError } from '../../shared/cockpit-error.js';
import {
  type BackgroundTask,
  type EndedSession,
  type EndReason,
  isSessionKey,
  type Session,
} from '../../shared/session.js';
import {
  type AgentEndReason,
  type Confinement,
  type Conversation,
  type Driver,
  type DriverEvent,
  type DriverPart,
  type HookAddress,
  type HookRequest,
  type LaunchCommand,
  type ScreenReading,
  type TypingOutcome,
  TypingStoppedError,
} from '../driver.js';
import type {
  Attachment,
  SessionEnvironment,
  SessionHost,
  TerminalSize,
} from '../session-host/session-host.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import type { TerminalHold } from '../terminal-hold.js';
import { InputBoxWait } from './input-box-wait.js';
import { LivenessWatch } from './liveness-watch.js';
import { ScreenWatch } from './screen-watch.js';
import { courseAfter, type SessionCourse } from './session-states.js';
import { type DialogShown, StartUpWatch } from './start-up-watch.js';
import { SessionTypingTerminal } from './typing-terminal.js';

export { INPUT_BOX_BOUND_MS } from './input-box-wait.js';
export { SCREEN_INTERVAL_MS } from './screen-watch.js';
export { READY_BOUND_MS, START_DEADLINE_MS } from './start-up-watch.js';

/**
 * How long after its first hook an agent launched with a prompt has to say
 * it took the prompt, before the cockpit reads its screen instead. Claude
 * Code's `UserPromptSubmit` comes 0.1–0.17 s after its `SessionStart`; a
 * local command (`/help`, `/clear`, `/context`) given as the prompt fires
 * none, and only the screen tells what the agent does then. The screen is
 * read from then on until it tells, or a hook does.
 */
export const PROMPT_BOUND_MS = 5_000;

/**
 * How often the host is listed to see sessions that are gone. A session's
 * end then reaches the app's page within a second, as its other changes
 * do; one list asks tmux once for every session, a few milliseconds, and
 * none is asked while no session lives. An attached terminal tells its
 * session's end sooner.
 */
export const LIVENESS_INTERVAL_MS = 1000;

/**
 * The terminal a session is started with, until a terminal attaches and
 * gives its own: wide enough that an agent's screen reads well when read
 * without a page.
 */
const DETACHED_SIZE: TerminalSize = { columns: 120, rows: 40 };

/**
 * Why an operation on a session — a run, a send, an open, an end — did
 * not settle as it would have: the cockpit was closed first. It carries no
 * code, since no request of an app's can mend it — on the wire it is a 500
 * with no body — and the session, if its agent was started, goes on in
 * tmux, as every session does when the app's server stops.
 */
export class SessionsClosedError extends Error {
  override readonly name = 'SessionsClosedError';

  /** @param key - The key of the operation that was pending. */
  constructor(key: string) {
    super(
      `The cockpit was closed before the operation on the session ${key} settled; an agent already started goes on in tmux.`,
    );
  }
}

/**
 * Hands out the address and token a session's hooks report with, and takes
 * the token back: the agent-facing listener's side of a session.
 */
export interface HookAccess {
  /**
   * Mints a new token for a launch of the session, which the listener
   * accepts from now on in place of any earlier one of that key.
   *
   * @param key - The session's key.
   * @returns Where its hooks report, and with which token.
   */
  grant(key: string): HookAddress;
  /**
   * Revokes the session's token: the listener refuses it from now on.
   *
   * @param key - The session's key.
   */
  revoke(key: string): void;
}

/** The sessions' folders in the state folder. */
export interface SessionFolders {
  /**
   * Makes sure the session's folder exists, readable by the app's user
   * alone.
   *
   * @param key - The session's key.
   * @returns The folder's absolute path.
   */
  prepare(key: string): Promise<string>;
}

/** What the sessions core works with. */
export interface SessionsOptions {
  /** Where the sessions live. */
  readonly host: SessionHost;
  /** The driver of the agent the sessions run. */
  readonly driver: Driver;
  /** The listener's side of each session. */
  readonly hooks: HookAccess;
  /** Where each session's files go. */
  readonly folders: SessionFolders;
  /**
   * Gives the environment a launch starts from, before the driver's
   * changes: the server's, without what the app hides from its sessions.
   */
  readonly environment: () => Readonly<Record<string, string>>;
  /**
   * Admits the agent a launch with this environment would run, before
   * anything of the launch is listed or written: rejects with why it may
   * not run (`agent-not-found`, `agent-too-old`).
   */
  readonly admitAgent: (environment: Readonly<Record<string, string>>) => Promise<void>;
  /**
   * Reads what a launch's agent must not reach, at each launch, before
   * anything of it is written: a launch whose confinement cannot be read
   * fails with that error.
   */
  readonly confinement: () => Promise<Confinement>;
  /** Holds the keys of the page's terminals of a session while a prompt is typed into it. */
  readonly holds: TerminalHold;
  /**
   * Sends a signal to a process: how a session's agent is asked to end
   * gracefully. `process.kill` when left out.
   */
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
}

/** One launch of a session's agent, what the units of work decided: which conversation, where, with what. */
export interface SessionLaunch {
  /** The key of the session's unit of work. */
  readonly key: string;
  /** The folder the agent works in: an absolute path. */
  readonly directory: string;
  /** The conversation the agent works in: one it keeps, resumed, or a new one under this id. */
  readonly conversationId: string;
  /** Whether the conversation is resumed; a new one is started when left out. */
  readonly resume?: boolean;
  /**
   * The first prompt; absent for a launch to type in, which starts at
   * `idle`. One the driver cannot pass on the agent's command line is
   * typed once the agent is ready: the session stays `starting` until the
   * agent takes it.
   */
  readonly prompt?: string;
  /** The job's driver part, checked, laid over the app's options at launch; none when it has none. */
  readonly part?: DriverPart;
}

/**
 * The cockpit's sessions: those it launched in this process, each by its
 * key, `ended` ones included.
 */
export interface Sessions {
  /**
   * Launches the agent of a key with no live session, and resolves once
   * the session leaves `starting`. An `ended` session of the key is
   * replaced by the new one.
   *
   * @param launch - See {@link SessionLaunch}.
   * @returns The session as it left `starting`: `busy` (the prompt taken),
   * `idle` (no prompt, or one the agent took without a turn), `waiting` (a
   * dialog in the terminal, which a person must answer), or `ended` (the
   * agent was gone before it reported: `declined` when it left a dialog).
   * A first prompt typed after the start settles the launch once the agent
   * took it (`busy`), or at `waiting` when a dialog showed first, never
   * waiting for a person: {@link firstPrompt} then tells what became of it.
   * @throws `TypeError` for a key that is no session key.
   * @throws `CockpitError` `wrong-state` when the key has a live session;
   * `unobservable` when the agent reported nothing and showed no dialog by
   * {@link START_DEADLINE_MS}, or within {@link READY_BOUND_MS} of showing
   * its input box: the session was ended. For a first prompt typed after
   * the start, what a send fails with (`prompt-not-taken`, `wrong-state`,
   * also when the session left `starting` before the box showed): the
   * session is then `idle`, unless it had left `starting`. What the agent's admission rejects with
   * (`agent-not-found`, `agent-too-old`), and what the driver's launch
   * rejects with (such as `sandbox-unavailable`).
   * @throws `SessionsClosedError` when the core is closed before the launch
   * settles, or was closed before it: a launch not yet on the host stops,
   * one already there goes on, unwatched.
   * @throws `SessionHostError` `session-exists` when a session of the key
   * that the cockpit did not launch lives on the host, left by an earlier
   * process of the app: nothing is written for it, and it is not listed.
   * Other `SessionHostError`s when the host fails.
   */
  launch(launch: SessionLaunch): Promise<Session>;
  /**
   * Types a prompt into an `idle` session, the keys of the page's
   * terminals held meanwhile, and resolves once the agent took it.
   *
   * @param key - The session's key.
   * @param prompt - The prompt.
   * @returns The session once the agent took the prompt.
   * @throws `CockpitError` `wrong-state` with the state the session is in
   * when it is not `idle` or is being ended, or when the typing found anything but the input
   * box, or the hooks told of anything but the prompt's own turn;
   * `prompt-not-taken` when the agent did not take it, the box cleared and
   * the person's draft put back. What the host fails with.
   */
  send(key: string, prompt: string): Promise<Session>;
  /**
   * What became of the first prompt of a key's session typed after the
   * start, whose launch may have settled `waiting` before it was typed.
   *
   * @param key - The session's key.
   * @returns A promise that settles once the agent took it (`busy`), or the
   * session ended first (`ended`), or that rejects as the launch would
   * have; `undefined` when the key's session has no prompt typed after
   * the start.
   * @throws (the promise) `CockpitError` `prompt-not-taken`, `wrong-state`
   * as {@link launch} lists; `SessionsClosedError` once the core is closed
   * before it settled.
   */
  firstPrompt(key: string): Promise<Session> | undefined;
  /**
   * Ends a live session gracefully: its agent is sent the driver's signal
   * and given the driver's bound to exit, keeping its conversation, then
   * killed on the host. The session is `ended` for the reason given. From
   * the moment it is asked until the session is gone, a send to it is
   * refused.
   *
   * @param key - The session's key.
   * @param reason - Why the cockpit ends it.
   * @returns The background tasks the `idle` session listed, stopped with
   * it; none for a session in another state, or with no live session.
   * @throws `SessionHostError` when the host cannot kill a session that
   * outlived the bound.
   * @throws `SessionsClosedError` when the core is closed, or is closed
   * while the agent is given its bound: nothing is signalled or killed
   * once it is.
   */
  end(key: string, reason: EndReason): Promise<readonly BackgroundTask[]>;
  /**
   * The session of a key, as it is now.
   *
   * @param key - The key.
   * @returns The session; `undefined` when this core launched none for the key.
   */
  session(key: string): Session | undefined;
  /**
   * The conversation a key's session works in now: the one launched, or one
   * the agent moved to.
   *
   * @param key - The key.
   * @returns Its id; `undefined` when this core launched no session for the key.
   */
  conversationOf(key: string): string | undefined;
  /**
   * Tells each move of a session's agent to another conversation (Claude
   * Code's `/clear`).
   *
   * @param listener - Called with the key, the new conversation's id and
   * the id of the one the agent left.
   * @returns A function that stops telling it.
   */
  onConversation(listener: ConversationListener): () => void;
  /**
   * The keys whose session lives, or is being launched or ended.
   *
   * @returns The keys, in the order they were first launched.
   */
  liveKeys(): string[];
  /**
   * Counts the terminals attached to a session: the page's and a person's
   * own `tmux attach`.
   *
   * @param key - The session's key.
   * @throws `SessionHostError` when the host fails.
   */
  terminalsAttached(key: string): Promise<number>;
  /**
   * Takes a request of a session's hooks, already proved to come from its
   * agent: the driver reads it, and the session's state follows. A request
   * of a key with no live session changes nothing.
   *
   * @param request - The request.
   */
  receive(request: HookRequest): void;
  /**
   * Attaches a terminal to a live session. Its end, when the session's is,
   * ends the session at once, without waiting for the next list of the host.
   *
   * @param key - The session's key.
   * @param size - The terminal's size.
   * @returns The attachment; `undefined` when no session of the key lives:
   * there is nothing to attach to.
   * @throws `SessionHostError` `host-failed` when the host fails.
   */
  attach(key: string, size: TerminalSize): Promise<Attachment | undefined>;
  /**
   * Lists the sessions, in the order their keys were first launched.
   *
   * @returns Each session as it is now.
   */
  list(): Session[];
  /**
   * Follows the sessions: the listener gets the list now, then the whole
   * list again at every change.
   *
   * @param listener - Called with the list.
   * @returns A function that stops the following.
   */
  follow(listener: (sessions: readonly Session[]) => void): () => void;
  /**
   * Stops watching: no timer of the core runs any more, and none starts.
   * Every launch still pending settles with `SessionsClosedError`; a launch
   * not yet on the host goes no further. The sessions themselves go on, on
   * the host: nothing is killed.
   */
  close(): void;
}

/**
 * Told a move of a session's agent to another conversation.
 *
 * @param key - The session's key.
 * @param conversationId - The conversation it moved to.
 * @param left - The conversation it left.
 */
export type ConversationListener = (key: string, conversationId: string, left: string) => void;

/**
 * Creates the sessions core.
 *
 * @param options - See {@link SessionsOptions}.
 * @returns The core, with no session; it runs nothing until a run.
 */
export function createSessions(options: SessionsOptions): Sessions {
  return new SessionRegistry(options);
}

/** Where a session's launch and life stand, beyond its public state. */
type Phase =
  /** Its key is taken; the host is asked whether an earlier session holds it. */
  | 'reserved'
  /**
   * It is listed `starting`; the agent is not on the host yet. Its hooks
   * are heard from the moment its token is granted.
   */
  | 'launching'
  /** It lives on the host. */
  | 'live'
  /**
   * It lives on the host, and the cockpit asked its agent to end: its hooks
   * are heard as it goes, but nothing is typed into it.
   */
  | 'ending'
  /** It lives on the host, and the cockpit is killing it: its hooks are not heard. */
  | 'killing'
  /** It is gone from the host; its end is being written. */
  | 'going'
  /** It ended. */
  | 'ended';

/** What a launch waits for: the session out of `starting`, or a failure to end it. */
interface Departure {
  readonly promise: Promise<Session>;
  resolve(session: Session): void;
  reject(error: unknown): void;
}

/** A promise settled by hand, once. */
interface Settled {
  readonly promise: Promise<void>;
  settle(): void;
}

function settled(): Settled {
  let settle = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function departure(): Departure {
  let resolve: (session: Session) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<Session>((resolved, rejected) => {
    resolve = resolved;
    reject = rejected;
  });
  // A close may settle it before the run awaits it.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** A session as the registry keeps it. */
interface Entry {
  readonly key: string;
  readonly directory: string;
  /** The environment the launch starts from, which the driver is given. */
  readonly environment: Readonly<Record<string, string>>;
  /** The conversation the agent works in: the one launched, until the agent names another. */
  conversationId: string;
  /** Whether the session has a first prompt: on the command line, or typed once the agent is ready. */
  readonly launchedWithPrompt: boolean;
  /** A first prompt too long for the command line, to type once the agent is ready; gone once begun. */
  promptToType?: string;
  /**
   * Whether the launch waits for its first prompt to be typed: it settles
   * once the agent took it, or the typing failed, or the session ended, or
   * at `waiting`, after which {@link firstPrompt} tells the rest.
   */
  awaitsTypedPrompt: boolean;
  readonly departure: Departure;
  /** What became of a first prompt typed after the start: settled once taken, failed, or the session ended. */
  readonly firstPrompt?: Departure;
  /** Settled once the session ended, or the core closed: what a graceful end waits for. */
  readonly ending: Settled;
  /** The terminal a prompt is being typed through, which hears the session's hooks. */
  typing?: SessionTypingTerminal;
  /**
   * The ended session of the key this launch replaces: listed until the
   * launch is, and back if it fails; let go once the launch is on the host.
   */
  replaces?: Entry;
  session: Session;
  /** What a compaction begun while `idle` returns the session to. */
  compactingFrom?: SessionCourse['compactingFrom'];
  /** When the agent last took a prompt. */
  promptTakenAt?: SessionCourse['promptTakenAt'];
  phase: Phase;
  /** Why the cockpit itself ends the session, which prevails over the agent's word. */
  endedBecause?: EndReason;
  /** Why the agent said it was ending. */
  agentSaid?: AgentEndReason;
  /**
   * Whether a hook of the agent's other than its end was heard: it can be
   * observed, and it is past its start-up dialogs.
   */
  heard: boolean;
  /** Reads the screen from the launch until {@link heard}. */
  startUp?: StartUpWatch;
  /** Starts reading the screen once the launch prompt was not taken in time. */
  promptBound?: NodeJS.Timeout;
  /** Reads the screen for what became of a launch prompt no hook said was taken. */
  promptWatch?: ScreenWatch;
  /**
   * Reads the screen, once the agent started, until it draws the input box
   * a first prompt too long for the command line is typed into; no hook
   * tells it.
   */
  inputBoxWait?: InputBoxWait;
  /**
   * Reads the screen while a compaction begun `idle` runs: an agent whose
   * compaction fails or is interrupted tells its end by no hook.
   */
  compactionWatch?: ScreenWatch;
  /** Stops following what the agent tells outside its hooks. */
  stopFollowing?: () => void;
  /**
   * Stops following the conversations the agent moved away from while a
   * turn was open, each still heard until no turn is.
   */
  readonly stopFollowingLeft: (() => void)[];
}

class SessionRegistry implements Sessions {
  readonly #options: SessionsOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #followers = new Set<(sessions: readonly Session[]) => void>();
  readonly #conversationListeners = new Set<ConversationListener>();
  readonly #watch: LivenessWatch;
  #closed = false;

  constructor(options: SessionsOptions) {
    this.#options = options;
    this.#watch = new LivenessWatch({
      list: () => options.host.list(),
      onGone: (key) => void this.#gone(key),
      intervalMs: LIVENESS_INTERVAL_MS,
    });
  }

  async launch(launch: SessionLaunch): Promise<Session> {
    const { key, prompt } = launch;
    if (!isSessionKey(key)) throw new TypeError(`${JSON.stringify(key)} is no session key.`);
    this.#refuseIfClosed(key);
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.phase !== 'ended') throw wrongState(existing.session);

    const onCommandLine =
      prompt === undefined || this.#options.driver.promptFitsLaunch(prompt) ? prompt : undefined;
    const entry = this.#reserve(launch, prompt, existing);
    await this.#refuseLeftOver(entry);
    await this.#launch(entry, { ...launch, prompt: onCommandLine });
    return this.#outcome(entry);
  }

  async send(key: string, prompt: string): Promise<Session> {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      throw new CockpitError('wrong-state', `The key ${key} has no session.`, {
        key,
        state: 'ended',
      });
    }
    if (entry.phase === 'ending') throw wrongState(entry.session, 'The cockpit is ending it.');
    if (!takesInput(entry) || entry.session.state !== 'idle') throw wrongState(entry.session);
    const outcome = await this.#type(entry, prompt);
    if (outcome !== 'taken') throw typingFailure(outcome, entry.session);
    return entry.session;
  }

  async end(key: string, reason: EndReason): Promise<readonly BackgroundTask[]> {
    this.#refuseIfClosed(key);
    const entry = this.#entries.get(key);
    if (entry?.phase !== 'live') return [];
    const { session } = entry;
    const stopped = session.state === 'idle' ? (session.backgroundTasks ?? []) : [];
    entry.endedBecause = reason;
    // From the moment it is asked, before the signal: no send types into it meanwhile.
    entry.phase = 'ending';
    const { signal, boundMs } = this.#options.driver.ending;
    await this.#signal(key, signal);
    const exited = await within(entry.ending.promise, boundMs);
    // Closed, the core no longer watches the session: whether it is gone, nothing tells.
    this.#refuseIfClosed(key);
    if (!exited) {
      entry.phase = 'killing';
      await this.#options.host.kill(key);
      await this.#gone(key);
    }
    return stopped;
  }

  firstPrompt(key: string): Promise<Session> | undefined {
    return this.#entries.get(key)?.firstPrompt?.promise;
  }

  session(key: string): Session | undefined {
    const entry = this.#entries.get(key);
    if (entry?.phase !== 'reserved') return entry?.session;
    return entry.replaces?.session;
  }

  conversationOf(key: string): string | undefined {
    return this.#entries.get(key)?.conversationId;
  }

  onConversation(listener: ConversationListener): () => void {
    const own: ConversationListener = (key, conversationId, left) =>
      listener(key, conversationId, left);
    this.#conversationListeners.add(own);
    return () => void this.#conversationListeners.delete(own);
  }

  liveKeys(): string[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.phase !== 'ended')
      .map((entry) => entry.key);
  }

  terminalsAttached(key: string): Promise<number> {
    return this.#options.host.countAttached(key);
  }

  /** Asks the session's agent to end: its process sent the signal, if it still has one. */
  async #signal(key: string, signal: NodeJS.Signals): Promise<void> {
    const agent = await this.#options.host.processOf(key).catch(() => undefined);
    if (agent === undefined || this.#closed) return;
    try {
      (this.#options.signal ?? process.kill)(agent.pid, signal);
    } catch {
      // Gone already: the watch tells its end.
    }
  }

  /**
   * Types a prompt into a live session through its checked terminal, the
   * page's terminals' keys held meanwhile.
   *
   * @returns What became of it; a write the terminal refused, which the
   * driver let through, is `no-input-box`: the session showed or told
   * something else.
   */
  async #type(entry: Entry, prompt: string): Promise<TypingOutcome> {
    const terminal = new SessionTypingTerminal({
      key: entry.key,
      host: this.#options.host,
      readInputBox: (text) => this.#options.driver.readInputBox(text),
      session: () => (takesInput(entry) && !this.#closed ? entry.session : undefined),
    });
    entry.typing = terminal;
    const release = this.#options.holds.hold(entry.key);
    try {
      return await this.#options.driver.typePrompt(prompt, terminal);
    } catch (error) {
      if (error instanceof TypingStoppedError) return 'no-input-box';
      throw error;
    } finally {
      terminal.close();
      if (entry.typing === terminal) delete entry.typing;
      release();
    }
  }

  /**
   * Types a first prompt too long for the command line, once the agent is
   * ready and its input box drawn, the page's terminals' keys held from
   * the agent's start (let through while a dialog in place of the box
   * waits for a person): the session stays `starting` until the agent
   * takes it, and the launch settles then. Not taken, no box drawn in
   * time, or the session no longer `starting` once the box shows (nothing
   * typed then), the launch fails as a send does; a session still
   * `starting` is then `idle`.
   */
  async #typeFirstPrompt(entry: Entry, prompt: string): Promise<void> {
    const keys = heldKeys(this.#options.holds, entry.key);
    let failure: ((session: Session) => unknown) | undefined;
    try {
      const shown = await this.#inputBoxShown(entry, keys);
      // Ended or closed meanwhile: the end, or the close, settles the launch.
      if (!takesInput(entry) || this.#closed) return;
      const outcome = await this.#typedFirstPrompt(entry, prompt, shown);
      if (outcome !== 'taken') failure = outcome;
    } catch (error) {
      failure = () => error;
    } finally {
      keys.release();
      entry.awaitsTypedPrompt = false;
    }
    if (failure === undefined) {
      settleFirstPrompt(entry, entry.session);
      return;
    }
    if (!takesInput(entry) || entry.session.state !== 'starting') {
      failFirstPrompt(entry, failure(entry.session));
      return;
    }
    const idle: Session = { key: entry.key, state: 'idle', since: now() };
    failFirstPrompt(entry, failure(idle));
    this.#update(entry, idle);
  }

  /**
   * Types the first prompt into the box shown, while the session is still
   * `starting`: nothing else began meanwhile (a turn of a prompt a person
   * typed, an ask).
   *
   * @returns `taken`, or why the launch fails, given the session as it is then.
   */
  async #typedFirstPrompt(
    entry: Entry,
    prompt: string,
    shown: boolean,
  ): Promise<'taken' | ((session: Session) => unknown)> {
    if (!shown) return (session) => typingFailure('no-input-box', session);
    if (entry.session.state !== 'starting') {
      return (session) => wrongState(session, 'Its first prompt was not typed.');
    }
    const outcome = await this.#type(entry, prompt);
    return outcome === 'taken' ? outcome : (session) => typingFailure(outcome, session);
  }

  /**
   * Waits for the agent to draw its input box, which Claude Code does a
   * moment after its `SessionStart`: a dialog in its place makes the
   * session wait in the terminal, the page's terminals' keys let through
   * for the person to answer it; `starting` again, the keys held again,
   * once the box shows.
   *
   * @returns Whether the box showed; `false` once the bound passed, or the
   * wait was stopped.
   */
  async #inputBoxShown(entry: Entry, keys: HeldKeys): Promise<boolean> {
    const wait = new InputBoxWait({
      read: () => this.#readScreen(entry.key),
      onDialog: (shown) => {
        keys.release();
        this.#waitInTerminal(entry, shown);
      },
    });
    entry.inputBoxWait = wait;
    const shown = await wait.start();
    delete entry.inputBoxWait;
    if (!shown || !takesInput(entry)) return shown;
    keys.hold();
    if (entry.session.state === 'waiting') {
      this.#update(entry, { key: entry.key, state: 'starting', since: now() });
    }
    return shown;
  }

  receive({ key, path, body }: HookRequest): void {
    const entry = this.#entries.get(key);
    if (!isListened(entry)) return;
    this.#told(entry, this.#options.driver.readHook({ key, path, body }).events);
  }

  /** Follows the session's state from what its agent told, a hook's events or others. */
  #told(entry: Entry, events: readonly DriverEvent[]): void {
    // Closed, the core runs no timer of its own: nothing it hears would be watched.
    if (this.#closed || !isListened(entry) || events.length === 0) return;
    const at = now();
    // One hook is one change: its followers never see a session half told.
    let course: SessionCourse = courseOf(entry);
    for (const event of events) {
      course = { ...course, session: this.#sessionAfterStartUp(entry, course.session, event) };
      // The agent says it ends, the session goes on until its process is
      // gone: declining a dialog may say so too, before any other hook.
      if (event.type === 'ending') entry.agentSaid = event.reason;
      else this.#hear(entry);
      if (event.type === 'conversation') this.#moveTo(entry, event.conversationId);
      course = courseAfter(course, event, entry.launchedWithPrompt, at);
    }
    this.#take(entry, course);
    entry.typing?.heard(events);
    if (events.some((event) => event.type === 'ready')) this.#awaitPrompt(entry);
  }

  /** Takes the course the session is on now: its state, and the watch of a compaction begun `idle`. */
  #take(entry: Entry, course: SessionCourse): void {
    entry.compactingFrom = course.compactingFrom;
    entry.promptTakenAt = course.promptTakenAt;
    this.#update(entry, course.session);
    if (!isInTurn(entry.session)) stopFollowingTheConversationsLeft(entry);
    if (entry.compactingFrom === undefined) this.#stopWatchingTheCompaction(entry);
    else if (entry.compactionWatch === undefined) this.#watchTheCompaction(entry);
  }

  /**
   * Reads the screen while the session compacts from `idle`: the input box
   * back with no hook to say so (a compaction that failed, or that a
   * person interrupted) is its end, and the session returns to the state
   * it left, as at `PostCompact`. Claude Code draws its busy hint by the
   * time it tells `PreCompact`, also while a slow hook of the person's
   * runs: the first box read is the end, however soon it was interrupted.
   */
  #watchTheCompaction(entry: Entry): void {
    const watch = new ScreenWatch({
      read: () => this.#readScreen(entry.key),
      onReading: (reading) => {
        if (reading.shows !== 'ready') return;
        const ended = courseAfter(
          courseOf(entry),
          { type: 'compaction-ended' },
          entry.launchedWithPrompt,
          now(),
        );
        this.#take(entry, ended);
      },
    });
    entry.compactionWatch = watch;
    watch.start();
  }

  #stopWatchingTheCompaction(entry: Entry): void {
    entry.compactionWatch?.stop();
    delete entry.compactionWatch;
  }

  /**
   * Follows the conversation the agent moved to, when it is another (Claude
   * Code's `/clear` starts one under a new id): what the driver tells
   * outside the hooks is read from it, and the session's end asks whether
   * it can resume.
   */
  #moveTo(entry: Entry, conversationId: string): void {
    const left = entry.conversationId;
    if (conversationId === left) return;
    entry.conversationId = conversationId;
    for (const listener of this.#conversationListeners) listener(entry.key, conversationId, left);
    // Not followed yet, during the launch: the following starts on the new one.
    if (entry.stopFollowing === undefined) return;
    // An Esc and then a `/clear` within a poll of the driver's leave the
    // interruption written only into the conversation left: it is heard
    // until the turn open now is over, whichever conversation tells it.
    entry.stopFollowingLeft.push(entry.stopFollowing);
    this.#follow(entry);
  }

  #follow(entry: Entry): void {
    entry.stopFollowing = this.#options.driver.follow(conversationOf(entry), (events) =>
      this.#told(entry, events),
    );
  }

  async attach(key: string, size: TerminalSize): Promise<Attachment | undefined> {
    const entry = this.#entries.get(key);
    if (entry?.phase !== 'live') return undefined;
    try {
      const attachment = await this.#options.host.attach(key, size);
      attachment.onEnd(() => void this.#checkLive(entry));
      return attachment;
    } catch (error) {
      if (!(error instanceof SessionHostError && error.reason === 'no-session')) throw error;
      await this.#gone(key);
      return undefined;
    }
  }

  list(): Session[] {
    return [...this.#entries.values()].flatMap((entry) => {
      if (entry.phase !== 'reserved') return [entry.session];
      return entry.replaces === undefined ? [] : [entry.replaces.session];
    });
  }

  follow(listener: (sessions: readonly Session[]) => void): () => void {
    // A wrapper of its own, so that one listener given twice is two followers.
    const follower = (sessions: readonly Session[]) => listener(sessions);
    this.#followers.add(follower);
    follower(this.list());
    return () => void this.#followers.delete(follower);
  }

  close(): void {
    this.#closed = true;
    this.#watch.close();
    for (const entry of this.#entries.values()) {
      // A graceful end stops waiting for its agent.
      entry.ending.settle();
      entry.typing?.close();
      entry.inputBoxWait?.stop();
      stopReadingTheScreen(entry);
      this.#stopWatchingTheCompaction(entry);
      stopFollowingEveryConversation(entry);
      failFirstPrompt(entry, new SessionsClosedError(entry.key));
    }
  }

  /** Takes the key at once, so that a second launch of it is refused before any wait. */
  #reserve(
    { key, directory, conversationId }: SessionLaunch,
    prompt: string | undefined,
    replaces: Entry | undefined,
  ): Entry {
    const typed = prompt !== undefined && !this.#options.driver.promptFitsLaunch(prompt);
    const entry: Entry = {
      key,
      directory,
      environment: this.#options.environment(),
      conversationId,
      launchedWithPrompt: prompt !== undefined,
      ...(typed ? { promptToType: prompt } : {}),
      awaitsTypedPrompt: typed,
      departure: departure(),
      ...(typed ? { firstPrompt: departure() } : {}),
      ending: settled(),
      session: { key, state: 'starting', since: now() },
      phase: 'reserved',
      heard: false,
      stopFollowingLeft: [],
      ...(replaces === undefined ? {} : { replaces }),
    };
    this.#entries.set(key, entry);
    return entry;
  }

  /** Gives the key back to what it held before a launch that failed: its ended session, or nothing. */
  #unreserve(entry: Entry): void {
    if (this.#entries.get(entry.key) !== entry) return;
    if (entry.replaces === undefined) this.#entries.delete(entry.key);
    else this.#entries.set(entry.key, entry.replaces);
  }

  /**
   * Refuses a key whose session an earlier process left on the host, before
   * anything is written: its agent may read its settings again, and must
   * never be handed this launch's token.
   */
  async #refuseLeftOver(entry: Entry): Promise<void> {
    const leftOver = await this.#options.host.isLive(entry.key).catch((error: unknown) => {
      this.#unreserve(entry);
      throw error;
    });
    if (leftOver) {
      this.#unreserve(entry);
      throw new SessionHostError(
        'session-exists',
        `A session of the key ${entry.key} lives on the host, left by an earlier run.`,
      );
    }
  }

  async #launch(
    entry: Entry,
    { prompt, part, resume }: Omit<SessionLaunch, 'prompt'> & { prompt: string | undefined },
  ): Promise<void> {
    const { host, driver, hooks, folders } = this.#options;
    let granted = false;
    try {
      this.#refuseIfClosed(entry.key);
      const { environment } = entry;
      await this.#options.admitAgent(environment);
      this.#refuseIfClosed(entry.key);
      this.#setPhase(entry, 'launching');
      const confinement = await this.#options.confinement();
      this.#refuseIfClosed(entry.key);
      const files = await folders.prepare(entry.key);
      this.#refuseIfClosed(entry.key);
      const address = hooks.grant(entry.key);
      granted = true;
      const command = await driver.launch({
        key: entry.key,
        conversationId: entry.conversationId,
        ...(resume === true ? { resume: true } : {}),
        directory: entry.directory,
        files,
        hooks: address,
        ...(prompt === undefined ? {} : { prompt }),
        ...(part === undefined ? {} : { part }),
        environment,
        confinement,
      });
      this.#refuseIfClosed(entry.key);
      await host.start({
        name: entry.key,
        folder: entry.directory,
        command: command.command,
        args: command.args,
        environment: exactly(command),
        size: DETACHED_SIZE,
      });
    } catch (error) {
      if (granted) hooks.revoke(entry.key);
      const listed = entry.phase !== 'reserved';
      this.#unreserve(entry);
      if (listed) this.#notify();
      throw error;
    }
    entry.phase = 'live';
    delete entry.replaces;
    // Closed while the host started it: the session goes on, unwatched.
    if (this.#closed) return;
    this.#watch.watch(entry.key);
    this.#follow(entry);
    if (!entry.heard) this.#watchStartUp(entry);
  }

  /**
   * Reads the screen until the agent's first hook: a dialog makes the
   * session wait in the terminal, and a start with neither is ended at the
   * watch's deadline.
   */
  #watchStartUp(entry: Entry): void {
    entry.startUp = new StartUpWatch({
      read: () => this.#readScreen(entry.key),
      onDialog: (shown) => this.#waitInTerminal(entry, shown),
      onDeadline: () => void this.#endUnobservable(entry),
    });
    entry.startUp.start();
  }

  /**
   * The agent is heard past its start: any hook proves it can be observed,
   * so a silent start whose kill failed is no longer one, and ends for its
   * own reason; the screen is no longer read.
   */
  #hear(entry: Entry): void {
    entry.heard = true;
    if (entry.endedBecause === 'unobservable') delete entry.endedBecause;
    stopReadingTheScreen(entry);
  }

  /**
   * The session an event of the agent applies to: a session that waited in
   * the terminal for a start-up dialog is `starting` again once the agent
   * goes on, whose hooks come only once every dialog is answered.
   */
  #sessionAfterStartUp(entry: Entry, session: Session, event: DriverEvent): Session {
    const pastDialog = event.type !== 'ending' && !entry.heard && session.state === 'waiting';
    if (!pastDialog) return session;
    return { key: session.key, state: 'starting', since: now() };
  }

  /**
   * Bounds the wait for a launch prompt once the agent is ready: a local
   * command fires no hook when the agent takes it, so the screen tells.
   */
  #awaitPrompt(entry: Entry): void {
    if (!entry.launchedWithPrompt || entry.session.state !== 'starting') return;
    const { promptToType } = entry;
    if (promptToType !== undefined) {
      delete entry.promptToType;
      void this.#typeFirstPrompt(entry, promptToType);
      return;
    }
    entry.promptBound = setTimeout(() => this.#watchForPrompt(entry), PROMPT_BOUND_MS);
  }

  /**
   * Reads what became of a launch prompt no hook said was taken, from now
   * on until the screen or a hook tells: the input box back means the agent
   * took it without a turn (a local command), and waits for the next
   * (`idle`); a panel waits for a person's key in the terminal (`waiting`,
   * until the box is back). A screen that tells neither, or cannot be read,
   * is read again: the session stays `starting`, never guessed `busy`, and
   * any hook ends the watch.
   */
  #watchForPrompt(entry: Entry): void {
    const watch = new ScreenWatch({
      read: () => this.#readScreen(entry.key),
      onReading: (reading) => {
        if (reading.shows === 'dialog') this.#waitInTerminal(entry, reading);
        if (reading.shows !== 'ready') return;
        watch.stop();
        this.#update(entry, { key: entry.key, state: 'idle', since: now() });
      },
    });
    entry.promptWatch = watch;
    watch.startNow();
  }

  /**
   * Makes the session wait for a person in the terminal, naming the dialog
   * when the driver knows it; a session already waiting for the same keeps
   * its `since`, and one whose dialog changed (onboarding, then login)
   * keeps it too: it waits all along.
   */
  #waitInTerminal(entry: Entry, { dialog }: DialogShown): void {
    const { session } = entry;
    if (session.state === 'waiting' && session.pending[0]?.dialog === dialog) return;
    this.#update(entry, {
      key: entry.key,
      state: 'waiting',
      since: session.state === 'waiting' ? session.since : now(),
      pending: [dialog === undefined ? { kind: 'terminal' } : { kind: 'terminal', dialog }],
    });
  }

  /**
   * Reads what the session's screen shows, as the driver tells it:
   * `undefined` when it cannot be read, or shows a person's scrolling back
   * rather than the agent's screen.
   */
  async #readScreen(key: string): Promise<ScreenReading | undefined> {
    try {
      const screen = await this.#options.host.readScreen(key);
      return screen.inCopyMode ? undefined : this.#options.driver.readScreen(screen.text);
    } catch {
      // Gone, or the host failed: the liveness watch tells the one, the next read the other.
      return undefined;
    }
  }

  /** Stops an operation once the core is closed: nothing more is put on the host, or taken off it. */
  #refuseIfClosed(key: string): void {
    if (this.#closed) throw new SessionsClosedError(key);
  }

  async #outcome(entry: Entry): Promise<Session> {
    const session = await entry.departure.promise;
    if (session.state === 'ended' && session.reason === 'unobservable') {
      throw new CockpitError('unobservable', 'The agent reported nothing; its session was ended.', {
        key: entry.key,
        cause: this.#options.driver.silentStartCause,
      });
    }
    return session;
  }

  /** Ends a session whose agent never reported: the cockpit keeps none it cannot observe. */
  async #endUnobservable(entry: Entry): Promise<void> {
    entry.endedBecause = 'unobservable';
    // From here the run's outcome is `unobservable`: a late hook changes nothing.
    entry.phase = 'killing';
    try {
      await this.#options.host.kill(entry.key);
    } catch (error) {
      // Still on the host, perhaps: the watch ends it when it goes.
      if (entry.phase === 'killing') entry.phase = 'live';
      entry.departure.reject(error);
      return;
    }
    await this.#gone(entry.key);
  }

  async #checkLive(entry: Entry): Promise<void> {
    if (entry.phase !== 'live' && entry.phase !== 'ending') return;
    try {
      if (!(await this.#options.host.isLive(entry.key))) await this.#gone(entry.key);
    } catch {
      // The watch's next list tells.
    }
  }

  /** Ends a session whose process is gone from the host. */
  async #gone(key: string): Promise<void> {
    const entry = this.#entries.get(key);
    if (entry === undefined || !isOnHost(entry)) return;
    entry.phase = 'going';
    entry.inputBoxWait?.stop();
    stopReadingTheScreen(entry);
    this.#stopWatchingTheCompaction(entry);
    stopFollowingEveryConversation(entry);
    this.#watch.unwatch(key);
    this.#options.hooks.revoke(key);
    const canResume = await this.#options.driver
      .canResume(conversationOf(entry))
      // A conversation the driver cannot find is one it cannot resume.
      .catch(() => false);
    entry.phase = 'ended';
    this.#update(entry, { key, state: 'ended', since: now(), canResume, ...endOf(entry) });
    entry.ending.settle();
  }

  #setPhase(entry: Entry, phase: Phase): void {
    entry.phase = phase;
    this.#notify();
  }

  #update(entry: Entry, session: Session): void {
    if (session === entry.session) return;
    entry.session = session;
    if (leftTheStart(entry, session)) entry.departure.resolve(session);
    if (entry.awaitsTypedPrompt && session.state === 'ended') settleFirstPrompt(entry, session);
    this.#notify();
  }

  #notify(): void {
    const sessions = this.list();
    for (const follower of this.#followers) follower(sessions);
  }
}

/**
 * Why a session whose process is gone ended: the cockpit's own reason
 * first; then a start-up dialog the screen showed last, before any hook
 * past it, which the person declined (the agent may say it ends as it
 * goes, as Claude Code does on the bypass warning); then the agent's word.
 */
function endOf(entry: Entry): Pick<EndedSession, 'reason' | 'dialog'> {
  if (entry.endedBecause !== undefined) return { reason: entry.endedBecause };
  const declined = entry.heard ? undefined : entry.startUp?.dialogShown;
  if (declined === undefined) return { reason: entry.agentSaid ?? 'lost' };
  return declined.dialog === undefined
    ? { reason: 'declined' }
    : { reason: 'declined', dialog: declined.dialog };
}

/**
 * Whether the launch settles on the session as it is now: once it left
 * `starting`, or, for a first prompt typed after the start, once it waits
 * for a person or ended — the typing settles it otherwise.
 */
function leftTheStart(entry: Entry, session: Session): boolean {
  if (entry.awaitsTypedPrompt) return session.state === 'waiting' || session.state === 'ended';
  return session.state !== 'starting';
}

/** Settles a first prompt typed after the start, and its launch if it had not settled. */
function settleFirstPrompt(entry: Entry, session: Session): void {
  entry.firstPrompt?.resolve(session);
  entry.departure.resolve(session);
}

/** Fails a first prompt typed after the start, and its launch if it had not settled. */
function failFirstPrompt(entry: Entry, error: unknown): void {
  entry.firstPrompt?.reject(error);
  entry.departure.reject(error);
}

/** A hold of the page's terminals' keys of a session, let go and taken again. */
interface HeldKeys {
  /** Holds the keys, unless they are held already. */
  hold(): void;
  /** Lets the keys through, if they are held. */
  release(): void;
}

/** Holds the page's terminals' keys of a session from now on. */
function heldKeys(holds: TerminalHold, key: string): HeldKeys {
  let release: (() => void) | undefined = holds.hold(key);
  return {
    hold() {
      release ??= holds.hold(key);
    },
    release() {
      release?.();
      release = undefined;
    },
  };
}

/**
 * Stops every read of the session's screen for its start and its launch
 * prompt, and every wait for one: a hook of the agent's tells from then on.
 */
function stopReadingTheScreen(entry: Entry): void {
  entry.startUp?.stop();
  entry.promptWatch?.stop();
  clearTimeout(entry.promptBound);
}

/** Whether a turn of the agent's is open: at work, or waiting on a person's answer. */
function isInTurn(session: Session): boolean {
  return session.state === 'busy' || session.state === 'waiting';
}

function stopFollowingTheConversationsLeft(entry: Entry): void {
  for (const stop of entry.stopFollowingLeft.splice(0)) stop();
}

function stopFollowingEveryConversation(entry: Entry): void {
  entry.stopFollowing?.();
  stopFollowingTheConversationsLeft(entry);
}

/** The conversation the session's agent works in now, as the driver is asked about it. */
function conversationOf(entry: Entry): Conversation {
  return {
    conversationId: entry.conversationId,
    directory: entry.directory,
    environment: entry.environment,
  };
}

/** Whether the session's agent was started on the host and is not known gone. */
function isOnHost(entry: Entry): boolean {
  return entry.phase === 'live' || entry.phase === 'ending' || entry.phase === 'killing';
}

/** Whether what a session's agent tells is listened to: from its launch until the cockpit kills it, or it is gone. */
function isListened(entry: Entry | undefined): entry is Entry {
  return entry?.phase === 'launching' || entry?.phase === 'live' || entry?.phase === 'ending';
}

/** Whether a prompt may be typed into the session: from its launch until the cockpit asks it to end. */
function takesInput(entry: Entry): boolean {
  return entry.phase === 'launching' || entry.phase === 'live';
}

function courseOf(entry: Entry): SessionCourse {
  const { session, compactingFrom, promptTakenAt } = entry;
  return {
    session,
    ...(compactingFrom === undefined ? {} : { compactingFrom }),
    ...(promptTakenAt === undefined ? {} : { promptTakenAt }),
  };
}

/**
 * The refusal of an operation the session's state does not allow: on a
 * `waiting` session, with everything it waits for.
 *
 * @param session - The session as it is.
 * @param detail - A sentence the message ends with: what the refused operation left.
 * @returns The error.
 */
export function wrongState(session: Session, detail?: string): CockpitError<'wrong-state'> {
  const message = `The session ${session.key} is ${session.state}.`;
  return new CockpitError('wrong-state', detail === undefined ? message : `${message} ${detail}`, {
    key: session.key,
    state: session.state,
    ...(session.state === 'waiting' ? { pending: session.pending } : {}),
  });
}

/**
 * Why a prompt typed was not taken: the agent did not take it, or no input
 * box took it, the message saying where the person's draft is when the
 * driver could not put it back.
 */
function typingFailure(
  outcome: Exclude<TypingOutcome, 'taken'>,
  session: Session,
): CockpitError<'wrong-state' | 'prompt-not-taken'> {
  if (outcome === 'no-input-box') return wrongState(session);
  if (outcome !== 'not-taken') return wrongState(session, outcome.draftLeft);
  return new CockpitError(
    'prompt-not-taken',
    `The session ${session.key} did not take the prompt.`,
    {
      key: session.key,
      state: session.state,
    },
  );
}

/** Whether the promise settles within the time, in milliseconds. */
async function within(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The host gives a session the calling process's environment with changes;
 * the driver's is the agent's whole one, so every other variable is removed.
 */
function exactly(command: LaunchCommand): SessionEnvironment {
  const remove = Object.keys(process.env).filter(
    (name) => !Object.hasOwn(command.environment, name),
  );
  return { set: command.environment, remove };
}

function now(): string {
  return new Date().toISOString();
}
