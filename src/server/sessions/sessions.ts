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
  type ScreenReading,
  type TypingOutcome,
  TypingStoppedError,
} from '../driver.js';
import type { Attachment, SessionHost, TerminalSize } from '../session-host/session-host.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import type { TerminalHold } from '../terminal-hold.js';
import { settlesBeforeAbort } from './abort-race.js';
import { FirstPrompt, type StartingSession } from './first-prompt.js';
import { Followers } from './followers.js';
import { Launches } from './launch.js';
import { LaunchPromptWatch } from './launch-prompt-watch.js';
import { LivenessWatch } from './liveness-watch.js';
import { typingFailure, wrongState } from './refusals.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { courseAfter, type SessionCourse } from './session-states.js';
import { type DialogShown, StartUpWatch } from './start-up-watch.js';
import { SessionTypingTerminal } from './typing-terminal.js';

export { INPUT_BOX_BOUND_MS } from './input-box-wait.js';
export { PROMPT_BOUND_MS } from './launch-prompt-watch.js';
export { wrongState } from './refusals.js';
export { SCREEN_INTERVAL_MS } from './screen-watch.js';
export { READY_BOUND_MS, START_DEADLINE_MS } from './start-up-watch.js';

/**
 * How often the host is listed to see sessions that are gone. A session's
 * end then reaches the app's page within a second, as its other changes
 * do; one list asks tmux once for every session, a few milliseconds, and
 * none is asked while no session lives. An attached terminal tells its
 * session's end sooner.
 */
export const LIVENESS_INTERVAL_MS = 1000;

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
   * Settles once the session ended, its end told, however its going was
   * seen first.
   * @throws `SessionHostError` when the host cannot kill a session that
   * outlived the bound: the session is live again, its agent heard, its
   * reason what it was, and a later end may kill it.
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
   * list again at every change. A listener that throws stops neither the
   * others nor the change: what it threw goes to `console.error`.
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

/** A session as the registry keeps it. */
interface Entry {
  readonly key: string;
  readonly directory: string;
  /** The environment the launch starts from, which the driver is given. */
  readonly environment: Readonly<Record<string, string>>;
  /** The conversation the agent works in: the one launched, until the agent names another. */
  conversationId: string;
  /**
   * Whether that conversation is known to be new — a launch that resumes
   * none, or one the agent moved to — and is followed from its start.
   */
  conversationIsNew: boolean;
  /** Whether the session has a first prompt: on the command line, or typed once the agent is ready. */
  readonly launchedWithPrompt: boolean;
  /** What becomes of the launch, and of a first prompt typed once the agent is ready. */
  readonly firstPrompt: FirstPrompt;
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
  /** Where its launch and life stand: what the core may do with it. */
  readonly lifecycle: SessionLifecycle;
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
  /** Reads the screen for a panel a launch prompt opened, which no hook nor entry tells. */
  promptWatch?: LaunchPromptWatch;
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
  readonly #followers = new Followers();
  readonly #conversationListeners = new Set<ConversationListener>();
  readonly #watch: LivenessWatch;
  /** Aborted by the close: what every operation under way checks before it goes on. */
  readonly #closing = new AbortController();
  readonly #launches: Launches<Entry>;

  constructor(options: SessionsOptions) {
    this.#options = options;
    this.#watch = new LivenessWatch({
      list: () => options.host.list(),
      onGone: (key) => void this.#goneByKey(key),
      intervalMs: LIVENESS_INTERVAL_MS,
    });
    this.#launches = new Launches({
      ...options,
      entries: this.#entries,
      closing: this.#closing.signal,
      notify: () => this.#notify(),
      refusal: (key) => new SessionsClosedError(key),
    });
  }

  async launch(launch: SessionLaunch): Promise<Session> {
    const { key, prompt, part, resume } = launch;
    if (!isSessionKey(key)) throw new TypeError(`${JSON.stringify(key)} is no session key.`);
    this.#refuseIfClosed(key);
    const existing = this.#entries.get(key);
    if (existing !== undefined && !existing.lifecycle.isEnded) throw wrongState(existing.session);

    const typed = prompt !== undefined && !this.#options.driver.promptFitsLaunch(prompt);
    const entry = this.#newEntry(launch, typed ? prompt : undefined, existing);
    this.#launches.reserve(entry);
    await this.#launches.start(entry, {
      prompt: typed ? undefined : prompt,
      ...(resume === undefined ? {} : { resume }),
      ...(part === undefined ? {} : { part }),
    });
    this.#watchLive(entry);
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
    if (entry.lifecycle.isBeingEnded) throw wrongState(entry.session, 'The cockpit is ending it.');
    if (!entry.lifecycle.takesInput || entry.session.state !== 'idle') {
      throw wrongState(entry.session);
    }
    const outcome = await this.#type(entry, prompt);
    if (outcome !== 'taken') throw typingFailure(outcome, entry.session);
    return entry.session;
  }

  async end(key: string, reason: EndReason): Promise<readonly BackgroundTask[]> {
    this.#refuseIfClosed(key);
    const entry = this.#entries.get(key);
    if (entry === undefined || !entry.lifecycle.isLive) return [];
    const { session } = entry;
    const stopped = session.state === 'idle' ? (session.backgroundTasks ?? []) : [];
    const reasonBefore = entry.endedBecause;
    entry.endedBecause = reason;
    // From the moment it is asked, before the signal: no send types into it meanwhile.
    entry.lifecycle.move('ending');
    const { signal, boundMs } = this.#options.driver.ending;
    await this.#signal(key, signal);
    const ended = settlesBeforeAbort(entry.lifecycle.ended, this.#closing.signal);
    const exited = await within(ended, boundMs);
    // Closed, the core no longer watches the session: whether it is gone, nothing tells.
    this.#refuseIfClosed(key);
    if (!exited) await this.#kill(entry, reasonBefore);
    return stopped;
  }

  /**
   * Kills a session whose agent did not exit within the driver's bound, and
   * waits for its end. One the core found gone meanwhile is not killed: its
   * end is awaited. A kill that fails leaves the session live, its reason
   * what it was before the end was asked.
   */
  async #kill(entry: Entry, reasonBefore: EndReason | undefined): Promise<void> {
    const { lifecycle } = entry;
    if (!lifecycle.can('killing')) return lifecycle.ended;
    lifecycle.move('killing');
    try {
      await this.#options.host.kill(entry.key);
    } catch (error) {
      // Gone meanwhile, the session ends all the same: the end did what it was asked.
      if (!lifecycle.can('live')) return lifecycle.ended;
      lifecycle.move('live');
      if (reasonBefore === undefined) delete entry.endedBecause;
      else entry.endedBecause = reasonBefore;
      throw error;
    }
    await this.#gone(entry);
  }

  firstPrompt(key: string): Promise<Session> | undefined {
    return this.#entries.get(key)?.firstPrompt.typed;
  }

  session(key: string): Session | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined || !entry.lifecycle.isReserved) return entry?.session;
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
      .filter((entry) => !entry.lifecycle.isEnded)
      .map((entry) => entry.key);
  }

  terminalsAttached(key: string): Promise<number> {
    return this.#options.host.countAttached(key);
  }

  /** Asks the session's agent to end: its process sent the signal, if it still has one. */
  async #signal(key: string, signal: NodeJS.Signals): Promise<void> {
    const agent = await this.#options.host.processOf(key).catch(() => undefined);
    if (agent === undefined || this.#closing.signal.aborted) return;
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
      session: () => (this.#takesInput(entry) ? entry.session : undefined),
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

  receive({ key, path, body }: HookRequest): void {
    const entry = this.#entries.get(key);
    if (entry === undefined || !entry.lifecycle.isListened) return;
    this.#told(entry, this.#options.driver.readHook({ key, path, body }).events);
  }

  /** Follows the session's state from what its agent told, a hook's events or others. */
  #told(entry: Entry, events: readonly DriverEvent[]): void {
    // Closed, the core runs no timer of its own: nothing it hears would be watched.
    if (this.#closing.signal.aborted || !entry.lifecycle.isListened || events.length === 0) return;
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

  /** Takes the course the session is on now. */
  #take(entry: Entry, course: SessionCourse): void {
    entry.compactingFrom = course.compactingFrom;
    entry.promptTakenAt = course.promptTakenAt;
    this.#update(entry, course.session);
    if (!isInTurn(entry.session)) stopFollowingTheConversationsLeft(entry);
  }

  /**
   * Follows the conversation the agent moved to, when it is another (Claude
   * Code's `/clear` starts one under a new id): what the driver tells
   * outside the hooks is read from it, from its start (the agent may write
   * into it before the following begins), and the session's end asks
   * whether it can resume.
   */
  #moveTo(entry: Entry, conversationId: string): void {
    const left = entry.conversationId;
    if (conversationId === left) return;
    entry.conversationId = conversationId;
    entry.conversationIsNew = true;
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
    const followed = { ...conversationOf(entry), isNew: entry.conversationIsNew };
    entry.stopFollowing = this.#options.driver.follow(followed, (events) =>
      this.#told(entry, events),
    );
  }

  async attach(key: string, size: TerminalSize): Promise<Attachment | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined || !entry.lifecycle.isLive) return undefined;
    try {
      const attachment = await this.#options.host.attach(key, size);
      attachment.onEnd(() => void this.#checkLive(entry));
      return attachment;
    } catch (error) {
      if (!(error instanceof SessionHostError && error.reason === 'no-session')) throw error;
      await this.#gone(entry);
      return undefined;
    }
  }

  list(): Session[] {
    return [...this.#entries.values()].flatMap((entry) => {
      if (!entry.lifecycle.isReserved) return [entry.session];
      return entry.replaces === undefined ? [] : [entry.replaces.session];
    });
  }

  follow(listener: (sessions: readonly Session[]) => void): () => void {
    return this.#followers.add(listener, this.list());
  }

  close(): void {
    // A graceful end stops waiting for its agent.
    this.#closing.abort();
    this.#watch.close();
    for (const entry of this.#entries.values()) {
      entry.typing?.close();
      entry.firstPrompt.stop();
      stopReadingTheScreen(entry);
      stopFollowingEveryConversation(entry);
      entry.firstPrompt.fail(new SessionsClosedError(entry.key));
    }
  }

  /** A session to launch, `reserved`: listed only once its launch begins. */
  #newEntry(
    { key, directory, conversationId, resume, prompt }: SessionLaunch,
    toType: string | undefined,
    replaces: Entry | undefined,
  ): Entry {
    return {
      key,
      directory,
      environment: this.#options.environment(),
      conversationId,
      conversationIsNew: resume !== true,
      launchedWithPrompt: prompt !== undefined,
      firstPrompt: new FirstPrompt(toType),
      session: { key, state: 'starting', since: now() },
      lifecycle: new SessionLifecycle('reserved'),
      heard: false,
      stopFollowingLeft: [],
      ...(replaces === undefined ? {} : { replaces }),
    };
  }

  /** Watches a session put on the host: its liveness, its agent's conversation and its start. */
  #watchLive(entry: Entry): void {
    // Closed while the host started it: the session goes on, unwatched.
    if (this.#closing.signal.aborted) return;
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
   * Follows a launch prompt once the agent is ready: a prompt too long for
   * the command line is typed now; one passed on it is taken with a hook, or
   * is a local command, which fires none. Such a command's end is written in
   * the transcript, which the core follows; a panel it opens is read on
   * screen.
   */
  #awaitPrompt(entry: Entry): void {
    if (!entry.launchedWithPrompt || entry.session.state !== 'starting') return;
    if (entry.firstPrompt.typeOnceReady(this.#starting(entry))) return;
    this.#watchForPanel(entry);
  }

  /**
   * Reads the screen for a panel the launch prompt opened, until a hook or
   * the transcript tells (any ends the watch): the panel makes the session
   * wait in the terminal, and the close of one the driver names, read by
   * its sign, makes it `idle`.
   */
  #watchForPanel(entry: Entry): void {
    const { driver } = this.#options;
    const watch = new LaunchPromptWatch({
      read: () => this.#readScreenText(entry.key),
      readScreen: (text) => driver.readScreen(text),
      signs: driver.screenStateSigns,
      onPanel: (shown) => this.#waitInTerminal(entry, shown),
      onPanelClosed: () => this.#update(entry, { key: entry.key, state: 'idle', since: now() }),
    });
    entry.promptWatch = watch;
    watch.start();
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
    const text = await this.#readScreenText(key);
    return text === undefined ? undefined : this.#options.driver.readScreen(text);
  }

  /** Reads the session's screen as text: `undefined` as {@link #readScreen} gives it. */
  async #readScreenText(key: string): Promise<string | undefined> {
    try {
      const screen = await this.#options.host.readScreen(key);
      return screen.inCopyMode ? undefined : screen.text;
    } catch {
      // Gone, or the host failed: the liveness watch tells the one, the next read the other.
      return undefined;
    }
  }

  /** Stops an operation once the core is closed: nothing more is put on the host, or taken off it. */
  #refuseIfClosed(key: string): void {
    if (this.#closing.signal.aborted) throw new SessionsClosedError(key);
  }

  async #outcome(entry: Entry): Promise<Session> {
    const session = await entry.firstPrompt.launched;
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
    const { lifecycle } = entry;
    // Being ended by the cockpit already, it ends for the reason it was asked; gone, it ends by itself.
    if (!lifecycle.isLive) return;
    entry.endedBecause = 'unobservable';
    // From here the run's outcome is `unobservable`: a late hook changes nothing.
    lifecycle.move('killing');
    try {
      await this.#options.host.kill(entry.key);
    } catch (error) {
      // Still on the host, perhaps: the watch ends it when it goes.
      if (lifecycle.can('live')) lifecycle.move('live');
      entry.firstPrompt.failLaunch(error);
      return;
    }
    await this.#gone(entry);
  }

  async #checkLive(entry: Entry): Promise<void> {
    if (!entry.lifecycle.isOnHost) return;
    try {
      if (!(await this.#options.host.isLive(entry.key))) await this.#gone(entry);
    } catch {
      // The watch's next list tells.
    }
  }

  #goneByKey(key: string): void {
    const entry = this.#entries.get(key);
    if (entry !== undefined) void this.#gone(entry);
  }

  /**
   * Ends a session whose process is gone from the host, once, however many
   * find it gone: each awaits the one end.
   */
  #gone(entry: Entry): Promise<void> {
    return entry.lifecycle.go(async () => {
      entry.firstPrompt.stop();
      stopReadingTheScreen(entry);
      stopFollowingEveryConversation(entry);
      this.#watch.unwatch(entry.key);
      this.#options.hooks.revoke(entry.key);
      const canResume = await this.#options.driver
        .canResume(conversationOf(entry))
        // A conversation the driver cannot find is one it cannot resume.
        .catch(() => false);
      const { key } = entry;
      return () =>
        this.#update(entry, { key, state: 'ended', since: now(), canResume, ...endOf(entry) });
    });
  }

  /** The session as its first prompt is typed into it. */
  #starting(entry: Entry): StartingSession {
    return {
      key: entry.key,
      holds: this.#options.holds,
      session: () => entry.session,
      takesInput: () => this.#takesInput(entry),
      readScreen: () => this.#readScreen(entry.key),
      waitInTerminal: (shown) => this.#waitInTerminal(entry, shown),
      type: (prompt) => this.#type(entry, prompt),
      update: (session) => this.#update(entry, session),
    };
  }

  /** Whether a prompt may be typed into the session now: the core open, the session not being ended. */
  #takesInput(entry: Entry): boolean {
    return entry.lifecycle.takesInput && !this.#closing.signal.aborted;
  }

  #update(entry: Entry, session: Session): void {
    if (session === entry.session) return;
    entry.session = session;
    entry.firstPrompt.changed(session);
    this.#notify();
  }

  #notify(): void {
    this.#followers.tell(() => this.list());
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
 * Stops every read of the session's screen for its start and its launch
 * prompt, and every wait for one: a hook of the agent's tells from then on.
 */
function stopReadingTheScreen(entry: Entry): void {
  entry.startUp?.stop();
  entry.promptWatch?.stop();
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

function courseOf(entry: Entry): SessionCourse {
  const { session, compactingFrom, promptTakenAt } = entry;
  return {
    session,
    ...(compactingFrom === undefined ? {} : { compactingFrom }),
    ...(promptTakenAt === undefined ? {} : { promptTakenAt }),
  };
}

/** Whether the promise settles within the time, in milliseconds. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
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

function now(): string {
  return new Date().toISOString();
}
