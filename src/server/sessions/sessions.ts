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
  type EndReason,
  isSessionKey,
  type RunResult,
  type Session,
} from '../../shared/session.js';
import type { AgentEndReason, Driver, HookAddress, HookRequest, LaunchCommand } from '../driver.js';
import type {
  Attachment,
  SessionEnvironment,
  SessionHost,
  TerminalSize,
} from '../session-host/session-host.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import { LivenessWatch } from './liveness-watch.js';
import { sessionAfter } from './session-states.js';

/**
 * How long a launched agent has to report it is ready before the cockpit
 * ends it as one it cannot observe (ADR-0035). Far above the slowest start
 * seen, about 2 s on a loaded machine; a start-up dialog, which also holds
 * the report back, is read from the screen first in a later version.
 */
export const SILENT_START_MS = 30_000;

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
}

/** What a run asks of the sessions core, the job already read. */
export interface SessionRun {
  /** The key of the run's unit of work. */
  readonly key: string;
  /** The folder the agent works in: an absolute path. */
  readonly directory: string;
  /** The first prompt; absent for a job for typing, which starts at `idle`. */
  readonly prompt?: string;
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
   * `starting` for: `busy` (the prompt taken), `idle` (no prompt), or
   * `ended` (the agent was gone before it reported).
   * @throws `TypeError` for a key that is no session key.
   * @throws `CockpitError` `wrong-state` when the key has a session, whatever
   * its state, for now; `unobservable` when the agent reported nothing within
   * {@link SILENT_START_MS}: the session was ended. What the driver's launch
   * rejects with, such as `agent-not-found`.
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
  readonly conversationId: string;
  readonly launchedWithPrompt: boolean;
  readonly departure: Departure;
  session: Session;
  phase: Phase;
  /** Why the cockpit itself ends the session, which prevails over the agent's word. */
  endedBecause?: EndReason;
  /** Why the agent said it was ending. */
  agentSaid?: AgentEndReason;
  /** Whether any hook of the agent's was heard: it can be observed. */
  heard: boolean;
  silentStart?: NodeJS.Timeout;
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

  async run({ key, directory, prompt }: SessionRun): Promise<RunResult> {
    if (!isSessionKey(key)) throw new TypeError(`${JSON.stringify(key)} is no session key.`);
    if (this.#closed) throw new SessionsClosedError(key);
    const existing = this.#entries.get(key);
    if (existing) throw wrongState(existing.session);

    const entry = this.#reserve(key, directory, prompt !== undefined);
    await this.#refuseLeftOver(entry);
    await this.#launch(entry, prompt);
    return this.#outcome(entry);
  }

  receive({ key, path, body }: HookRequest): void {
    const entry = this.#entries.get(key);
    if (entry?.phase !== 'launching' && entry?.phase !== 'live') return;
    const { events } = this.#options.driver.readHook({ key, path, body });
    for (const event of events) {
      // Any hook at all proves the session can be observed: a silent start
      // whose kill failed is no longer one, and ends for its own reason.
      entry.heard = true;
      delete entry.endedBecause;
      clearTimeout(entry.silentStart);
      if (event.type === 'ending') entry.agentSaid = event.reason;
      this.#update(entry, sessionAfter(entry.session, event, entry.launchedWithPrompt, now()));
    }
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
      clearTimeout(entry.silentStart);
      entry.departure.reject(new SessionsClosedError(entry.key));
    }
  }

  /** Takes the key at once, so that a second run of it is refused before any wait. */
  #reserve(key: string, directory: string, launchedWithPrompt: boolean): Entry {
    const entry: Entry = {
      key,
      directory,
      conversationId: randomUUID(),
      launchedWithPrompt,
      departure: departure(),
      session: { key, state: 'starting', since: now() },
      phase: 'reserved',
      heard: false,
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

  async #launch(entry: Entry, prompt: string | undefined): Promise<void> {
    const { host, driver, hooks, folders } = this.#options;
    let granted = false;
    try {
      this.#refuseIfClosed(entry);
      this.#setPhase(entry, 'launching');
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
        environment: this.#options.environment(),
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
    if (!entry.heard) {
      entry.silentStart = setTimeout(() => void this.#endSilent(entry), SILENT_START_MS);
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
  async #endSilent(entry: Entry): Promise<void> {
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
    clearTimeout(entry.silentStart);
    this.#watch.unwatch(key);
    this.#options.hooks.revoke(key);
    const canResume = await this.#options.driver
      .canResume({ conversationId: entry.conversationId, directory: entry.directory })
      // A conversation the driver cannot find is one it cannot resume.
      .catch(() => false);
    entry.phase = 'ended';
    this.#update(entry, {
      key,
      state: 'ended',
      since: now(),
      canResume,
      reason: entry.endedBecause ?? entry.agentSaid ?? 'lost',
    });
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
