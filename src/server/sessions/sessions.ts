/**
 * The sessions core: the registry of the cockpit's sessions by key, their
 * states as the driver's events and the host tell them, the launch of a run,
 * and the list an app and the browser follow. It speaks to tmux only through
 * the session host, and to the agent only through the driver.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { CockpitError } from '../../shared/cockpit-error.js';
import {
  type EndedSession,
  type EndReason,
  isSessionKey,
  type RunResult,
  type Session,
} from '../../shared/session.js';
import type {
  AgentEndReason,
  Confinement,
  Conversation,
  Driver,
  DriverEvent,
  DriverPart,
  HookAddress,
  HookRequest,
  LaunchCommand,
  ScreenReading,
} from '../driver.js';
import type {
  Attachment,
  SessionEnvironment,
  SessionHost,
  TerminalSize,
} from '../session-host/session-host.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import { LivenessWatch } from './liveness-watch.js';
import { ScreenWatch } from './screen-watch.js';
import { courseAfter, type SessionCourse } from './session-states.js';
import { type DialogShown, StartUpWatch } from './start-up-watch.js';

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
 * Why a run did not settle as a launch does: the cockpit was closed first.
 * It carries no code, since no request of an app's can mend it — on the
 * wire it is a 500 with no body — and the session, if its agent was
 * started, goes on in tmux, as every session does when the app's server
 * stops.
 */
export class SessionsClosedError extends Error {
  override readonly name = 'SessionsClosedError';

  /** @param key - The key of the run that was pending. */
  constructor(key: string) {
    super(
      `The cockpit was closed before the session ${key} left \`starting\`; an agent already started goes on in tmux.`,
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
}

/** What a run asks of the sessions core, the job already read. */
export interface SessionRun {
  /** The key of the run's unit of work. */
  readonly key: string;
  /** The folder the agent works in: an absolute path. */
  readonly directory: string;
  /** The first prompt; absent for a job for typing, which starts at `idle`. */
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
   * Runs a job's prompt on its key. On a key with no session, launches the
   * agent and resolves once the session leaves `starting`.
   *
   * @param run - See {@link SessionRun}.
   * @returns `{ action: 'started' }` with the state the session left
   * `starting` for: `busy` (the prompt taken), `idle` (no prompt, or one
   * the agent took without a turn), `waiting` (a dialog in the terminal,
   * which a person must answer), or `ended` (the agent was gone before it
   * reported: `declined` when it left a dialog).
   * @throws `TypeError` for a key that is no session key.
   * @throws `CockpitError` `wrong-state` when the key has a session, whatever
   * its state, for now; `unobservable` when the agent reported nothing and
   * showed no dialog by {@link START_DEADLINE_MS}, or within
   * {@link READY_BOUND_MS} of showing its input box: the session was ended.
   * What the agent's admission rejects with (`agent-not-found`,
   * `agent-too-old`), and what the driver's launch rejects with (such as
   * `sandbox-unavailable`).
   * @throws `SessionsClosedError` when the core is closed before the run
   * settles, or was closed before it: a launch not yet on the host stops,
   * one already there goes on, unwatched.
   * @throws `SessionHostError` `session-exists` when a session of the key
   * that the cockpit did not launch lives on the host, left by an earlier
   * process of the app: nothing is written for it, and it is not listed.
   * Other `SessionHostError`s when the host fails.
   */
  run(run: SessionRun): Promise<RunResult>;
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
   * Lists the sessions, in the order their keys were first run.
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
   * Every run still pending settles with `SessionsClosedError`; a launch
   * not yet on the host goes no further. The sessions themselves go on, on
   * the host: nothing is killed.
   */
  close(): void;
}

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
  readonly launchedWithPrompt: boolean;
  readonly departure: Departure;
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

  async run({ key, directory, prompt, part }: SessionRun): Promise<RunResult> {
    if (!isSessionKey(key)) throw new TypeError(`${JSON.stringify(key)} is no session key.`);
    if (this.#closed) throw new SessionsClosedError(key);
    const existing = this.#entries.get(key);
    if (existing) throw wrongState(existing.session);

    const entry = this.#reserve(key, directory, prompt !== undefined);
    await this.#refuseLeftOver(entry);
    await this.#launch(entry, { prompt, part });
    return this.#outcome(entry);
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
    if (conversationId === entry.conversationId) return;
    entry.conversationId = conversationId;
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
    return [...this.#entries.values()]
      .filter((entry) => entry.phase !== 'reserved')
      .map((entry) => entry.session);
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
      stopReadingTheScreen(entry);
      this.#stopWatchingTheCompaction(entry);
      stopFollowingEveryConversation(entry);
      entry.departure.reject(new SessionsClosedError(entry.key));
    }
  }

  /** Takes the key at once, so that a second run of it is refused before any wait. */
  #reserve(key: string, directory: string, launchedWithPrompt: boolean): Entry {
    const entry: Entry = {
      key,
      directory,
      environment: this.#options.environment(),
      conversationId: randomUUID(),
      launchedWithPrompt,
      departure: departure(),
      session: { key, state: 'starting', since: now() },
      phase: 'reserved',
      heard: false,
      stopFollowingLeft: [],
    };
    this.#entries.set(key, entry);
    return entry;
  }

  /**
   * Refuses a key whose session an earlier process left on the host, before
   * anything is written: its agent may read its settings again, and must
   * never be handed this launch's token.
   */
  async #refuseLeftOver(entry: Entry): Promise<void> {
    const leftOver = await this.#options.host.isLive(entry.key).catch((error: unknown) => {
      this.#entries.delete(entry.key);
      throw error;
    });
    if (leftOver) {
      this.#entries.delete(entry.key);
      throw new SessionHostError(
        'session-exists',
        `A session of the key ${entry.key} lives on the host, left by an earlier run.`,
      );
    }
  }

  async #launch(
    entry: Entry,
    { prompt, part }: { prompt: string | undefined; part: DriverPart | undefined },
  ): Promise<void> {
    const { host, driver, hooks, folders } = this.#options;
    let granted = false;
    try {
      this.#refuseIfClosed(entry);
      const { environment } = entry;
      await this.#options.admitAgent(environment);
      this.#refuseIfClosed(entry);
      this.#setPhase(entry, 'launching');
      const confinement = await this.#options.confinement();
      this.#refuseIfClosed(entry);
      const files = await folders.prepare(entry.key);
      this.#refuseIfClosed(entry);
      const address = hooks.grant(entry.key);
      granted = true;
      const command = await driver.launch({
        key: entry.key,
        conversationId: entry.conversationId,
        directory: entry.directory,
        files,
        hooks: address,
        ...(prompt === undefined ? {} : { prompt }),
        ...(part === undefined ? {} : { part }),
        environment,
        confinement,
      });
      this.#refuseIfClosed(entry);
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
      this.#entries.delete(entry.key);
      if (listed) this.#notify();
      throw error;
    }
    entry.phase = 'live';
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
    delete entry.endedBecause;
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

  /** Stops a launch once the core is closed: nothing more is put on the host. */
  #refuseIfClosed(entry: Entry): void {
    if (this.#closed) throw new SessionsClosedError(entry.key);
  }

  async #outcome(entry: Entry): Promise<RunResult> {
    const session = await entry.departure.promise;
    if (session.state === 'ended' && session.reason === 'unobservable') {
      throw new CockpitError('unobservable', 'The agent reported nothing; its session was ended.', {
        key: entry.key,
        cause: this.#options.driver.silentStartCause,
      });
    }
    return { action: 'started', state: session.state };
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
    if (entry.phase !== 'live') return;
    try {
      if (!(await this.#options.host.isLive(entry.key))) await this.#gone(entry.key);
    } catch {
      // The watch's next list tells.
    }
  }

  /** Ends a session whose process is gone from the host. */
  async #gone(key: string): Promise<void> {
    const entry = this.#entries.get(key);
    if (entry?.phase !== 'live' && entry?.phase !== 'killing') return;
    entry.phase = 'going';
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
  }

  #setPhase(entry: Entry, phase: Phase): void {
    entry.phase = phase;
    this.#notify();
  }

  #update(entry: Entry, session: Session): void {
    if (session === entry.session) return;
    entry.session = session;
    if (session.state !== 'starting') entry.departure.resolve(session);
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

/** Whether what a session's agent tells is listened to: from its launch until the cockpit ends it. */
function isListened(entry: Entry | undefined): entry is Entry {
  return entry?.phase === 'launching' || entry?.phase === 'live';
}

function courseOf(entry: Entry): SessionCourse {
  const { session, compactingFrom, promptTakenAt } = entry;
  return {
    session,
    ...(compactingFrom === undefined ? {} : { compactingFrom }),
    ...(promptTakenAt === undefined ? {} : { promptTakenAt }),
  };
}

function wrongState(session: Session): CockpitError<'wrong-state'> {
  return new CockpitError('wrong-state', `The session ${session.key} is ${session.state}.`, {
    key: session.key,
    state: session.state,
  });
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
