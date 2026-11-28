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

import type { AskSettled } from '../../shared/ask.js';
import { CockpitError } from '../../shared/cockpit-error.js';
import {
  type BackgroundTask,
  type EndedSession,
  type EndReason,
  type EndResult,
  type InterruptResult,
  isSessionKey,
  type Session,
} from '../../shared/session.js';
import type { HeldHook, HookHold } from '../agent-listener/agent-listener.js';
import type { Answering, Asks } from '../asks/asks.js';
import {
  type AgentEndReason,
  type AskOfCall,
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
import { fulfilledWithin, settlesBeforeAbort } from './abort-race.js';
import { endAfterInterrupt } from './end-after-interrupt.js';
import { FirstPrompt, type StartingSession } from './first-prompt.js';
import { Followers } from './followers.js';
import { Launches } from './launch.js';
import { LaunchPromptWatch } from './launch-prompt-watch.js';
import { LivenessWatch } from './liveness-watch.js';
import { typingFailure, wrongState } from './refusals.js';
import { SessionLifecycle } from './session-lifecycle.js';
import {
  asksSettledBy,
  courseAfter,
  courseAsked,
  courseSettled,
  courseWithdrawn,
  type SessionCourse,
  tasksKnown,
} from './session-states.js';
import { type DialogShown, StartUpWatch } from './start-up-watch.js';
import { type InterruptedSession, interruptTurn } from './turn-interrupt.js';
import { SessionTypingTerminal } from './typing-terminal.js';
import { WithdrawnWatch } from './withdrawn-watch.js';

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
 * Why an operation on a session — a run, a send, an open, an interrupt, an end — did
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
  /**
   * Deletes the session's folder and all it holds — the files the driver
   * wrote there, its hook token among them. A symbolic link in it, or in its
   * place, is deleted as a link: what it leads to is left as it is. Nothing
   * to do when the key has no folder. Callers serialize it with `prepare`
   * for the same key, in the key's queue: a folder prepared while it is
   * deleted could be lost under a launch.
   *
   * @param key - The session's key.
   * @throws `TypeError` when the key is not of the form `[a-z0-9-]+`: its
   * folder could lie outside the sessions' folder, and nothing is deleted.
   * The file system's error when the folder cannot be deleted whole.
   */
  remove(key: string): Promise<void>;
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
   * The asks of every session: the core opens there what its sessions'
   * agents ask a person, settles them from what the agents tell, and
   * follows the app's answers.
   */
  readonly asks: Asks;
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
   * @returns The background tasks known running as its process went,
   * stopped with it: those an `idle` session listed, or those a session in
   * a turn listed before it and the subagents the turn started; none with
   * no live session. Settles once the session ended, its end told, however
   * its going was seen first. Asked of a session the cockpit is already
   * ending, or whose going from the host began, it waits for that end, its
   * reason kept, and gives the tasks that end stopped; when that end's kill
   * failed, it ends the session itself, for its own reason.
   * @throws `SessionHostError` when the host cannot kill a session that
   * outlived the bound: the session is live again, its agent heard, its
   * reason what it was, and a later end may kill it.
   * @throws `SessionsClosedError` when the core is closed, or is closed
   * while the agent is given its bound: nothing is signalled or killed
   * once it is.
   */
  end(key: string, reason: EndReason): Promise<readonly BackgroundTask[]>;
  /**
   * Ends a key's session as an app asks: its turn interrupted first, then
   * ended as {@link end} does. A `busy` session, or one waiting on more
   * than the terminal, has its turn interrupted as {@link interrupt} does,
   * but a prompt it withdraws is left in the box (no key goes in once the
   * end was asked), then is ended whether or not the interrupt was
   * confirmed; an `idle` one, or one waiting in the terminal only (a
   * start-up dialog, a panel), is ended at once, no key pressed. A session
   * the cockpit is ending already has that end awaited, its reason kept;
   * one that end left live, its kill failed, is then ended by this one, by
   * its state then, its turn interrupted first. From the moment it is
   * asked, a process that goes ended for the reason given, though the
   * agent said otherwise or a start-up dialog showed.
   *
   * @param key - The session's key.
   * @param reason - Why the cockpit ends it.
   * @returns `ended` once the session ended, its process gone, with the
   * background tasks known running as it went, stopped with it;
   * `nothing-to-end` with the session's state, none for a key with no
   * session, on an `ended` one.
   * @throws `CockpitError` `wrong-state` on a `starting` session.
   * @throws `SessionHostError` when the host cannot kill a session that
   * outlived the driver's bound: the session is live again, heard, and a
   * later end may kill it.
   * @throws `SessionsClosedError` when the core is closed, or is closed
   * before the end settles: nothing more is pressed, signalled or killed.
   */
  interruptAndEnd(key: string, reason: EndReason): Promise<EndResult>;
  /**
   * Interrupts the turn of a key's session, as `interruptTurn` does: the
   * driver's keys pressed once, never twice, on a `busy` session or one
   * waiting on more than the terminal, then the driver's bound for it to
   * be `idle`; nothing pressed where no turn runs. A session the cockpit is
   * ending is first awaited ended, then read again. Background tasks go
   * on: the `idle` session lists those it listed before the turn and the
   * subagents the turn started; a shell or a monitor the turn started
   * fires no hook as it starts, and is listed from the next end of a turn. A prompt withdrawn into the input box is cleared once
   * the screen showed it, whoever pressed the Esc: a person's Esc in the
   * terminal while the interrupt waits cannot be told from the cockpit's.
   *
   * @param key - The session's key.
   * @returns `interrupted` once the session is `idle`, told before a
   * withdrawn prompt is cleared; `nothing-to-interrupt` with the session's
   * state, none for a key with no session, when there was no turn to stop
   * or the session ended meanwhile.
   * @throws `CockpitError` `wrong-state` on a `starting` session;
   * `interrupt-unconfirmed` with the key and the last state when the
   * session was not `idle` within the driver's bound, left as it is. What
   * the host fails with as the keys are pressed.
   * @throws `SessionsClosedError` when the core is closed, or is closed
   * before the interrupt settles: nothing more is pressed.
   */
  interrupt(key: string): Promise<InterruptResult>;
  /**
   * Forgets a key whose session ended, as a unit of work removed: it is no
   * longer listed, and its conversation is unknown, so that its next launch
   * replaces nothing and follows on from no conversation. Its followers are
   * told when there was a session to forget.
   *
   * @param key - The key.
   * @returns Whether the core had a session of the key to forget.
   * @throws `CockpitError` `wrong-state` with the session's state when it
   * has not ended: a live session is never forgotten while it runs.
   */
  forget(key: string): boolean;
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
   * of a key with no live session changes nothing. A request that asks a
   * person is held and opens an ask the app can answer, while its session
   * is launched or live and not being ended; on any other session it is
   * answered `{}` at once, the dialog left to the terminal.
   *
   * @param request - The request.
   * @param hold - Holds the request, for a reply given later, when called
   * synchronously before `receive` returns; a request not held is
   * answered `{}`.
   */
  receive(request: HookRequest, hold: HookHold): void;
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
  /** What the agent told that a later event needs and the session does not carry. */
  told: Omit<SessionCourse, 'session'>;
  /** Called at each change of the session, until they unsubscribe. */
  readonly changeListeners: Set<(session: Session) => void>;
  /** Reads the screen for the open turn's prompt withdrawn by an early Esc, which nothing else tells. */
  readonly withdrawal: WithdrawnWatch;
  /** Where its launch and life stand: what the core may do with it. */
  readonly lifecycle: SessionLifecycle;
  /** Why the cockpit itself ends the session, which prevails over the agent's word. */
  endedBecause?: EndReason;
  /**
   * Why an app asked the session to end, while its turn is interrupted
   * before the end begins: it prevails over the agent's word too.
   */
  endAskedBecause?: EndReason;
  /** Why the agent said it was ending. */
  agentSaid?: AgentEndReason;
  /** The background tasks known running as its process went: those its end stopped. */
  stoppedTasks?: readonly BackgroundTask[];
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
  /** Its agent's asks still pending, by id: the call each is about, and its held hook. */
  readonly asks: Map<string, OpenAsk>;
}

/** An ask of a session's agent, pending, as the core keeps it. */
interface OpenAsk {
  /** The driver's reference to the call the ask is about. */
  readonly ref: string;
  /** The hook the agent waits on for the app's answer; none for an ask answerable in the terminal only. */
  readonly held?: HeldHook;
}

/** An ask the core opens: what the driver read, and how the agent's request is held for the app's answer. */
interface Asked {
  readonly ask: AskOfCall;
  /** Holds the request; none for an ask answerable in the terminal only. */
  readonly hold?: HookHold;
}

/** An ask the core settled from what the agent told, its registry told after the session's change. */
interface Settlement {
  readonly id: string;
  readonly open: OpenAsk;
  readonly by: 'terminal' | 'cancelled';
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
  readonly #stopHearingAnswers: () => void;

  constructor(options: SessionsOptions) {
    this.#options = options;
    this.#stopHearingAnswers = options.asks.on('settled', (settled) => this.#answered(settled));
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
    if (entry === undefined || !(entry.lifecycle.isLive || entry.lifecycle.hasEndUnderWay)) {
      return [];
    }
    return this.#endOrJoin(entry, reason);
  }

  async interruptAndEnd(key: string, reason: EndReason): Promise<EndResult> {
    this.#refuseIfClosed(key);
    const entry = this.#entries.get(key);
    if (entry === undefined) return { action: 'nothing-to-end' };
    // A process that goes while its turn is interrupted goes because the cockpit asked it to.
    const askToEnd = () => {
      if (entry.lifecycle.isLive) entry.endAskedBecause = reason;
    };
    askToEnd();
    try {
      return await endAfterInterrupt({
        session: () => this.session(key),
        hasEndUnderWay: () => entry.lifecycle.hasEndUnderWay,
        // The prompt it may withdraw is left in the box: no key goes in once the end was asked.
        interrupt: () => this.#interruptTurn(entry, this.#interruptTarget(entry)),
        end: () => this.#endOrJoin(entry, reason),
        join: async () => {
          const stopped = await this.#join(entry);
          // Live again, its kill failed: this end is the one asked now.
          askToEnd();
          return stopped;
        },
      });
    } finally {
      delete entry.endAskedBecause;
    }
  }

  /**
   * Ends a live session, or waits for the end under way or the going of
   * one that is not: the tasks known as its process went.
   */
  async #endOrJoin(entry: Entry, reason: EndReason): Promise<readonly BackgroundTask[]> {
    this.#refuseIfClosed(entry.key);
    return entry.lifecycle.isLive ? this.#endLive(entry, reason) : this.#joinEnd(entry, reason);
  }

  /** Ends a live session: its agent signalled, given the driver's bound, then killed. */
  async #endLive(entry: Entry, reason: EndReason): Promise<readonly BackgroundTask[]> {
    const reasonBefore = entry.endedBecause;
    entry.endedBecause = reason;
    // From the moment it is asked, before the signal: no send types into it meanwhile.
    entry.lifecycle.move('ending');
    const { signal, boundMs } = this.#options.driver.ending;
    await this.#signal(entry.key, signal);
    const ended = entry.lifecycle.ended.then(() => true);
    const exited = (await fulfilledWithin(ended, boundMs, this.#closing.signal)) ?? false;
    // Closed, the core no longer watches the session: whether it is gone, nothing tells.
    this.#refuseIfClosed(entry.key);
    if (!exited) await this.#kill(entry, reasonBefore);
    return entry.stoppedTasks ?? [];
  }

  /**
   * Waits for the end under way of a session asked to end again, and gives
   * the tasks that end stopped. One whose kill failed left the session
   * live, or another waiting end began anew: this end then ends it, for
   * its own reason, or joins that one.
   */
  async #joinEnd(entry: Entry, reason: EndReason): Promise<readonly BackgroundTask[]> {
    const stopped = await this.#join(entry);
    const { lifecycle } = entry;
    return lifecycle.isLive || lifecycle.hasEndUnderWay ? this.#endOrJoin(entry, reason) : stopped;
  }

  /**
   * Waits for the end under way of a session, and gives the tasks known as
   * its process went: none when it is live again, its kill failed.
   */
  async #join(entry: Entry): Promise<readonly BackgroundTask[]> {
    await settlesBeforeAbort(entry.lifecycle.endUnderWay, this.#closing.signal);
    this.#refuseIfClosed(entry.key);
    return entry.stoppedTasks ?? [];
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

  async interrupt(key: string): Promise<InterruptResult> {
    this.#refuseIfClosed(key);
    const entry = this.#entries.get(key);
    if (entry === undefined) return { action: 'nothing-to-interrupt' };
    const { driver } = this.#options;
    return this.#interruptTurn(entry, {
      ...this.#interruptTarget(entry),
      clearInputBox: () =>
        this.#throughTypingTerminal(entry, (terminal) => driver.clearInputBox(terminal)),
    });
  }

  /** Interrupts a session's turn once the end under way, if any, settled. */
  async #interruptTurn(entry: Entry, target: InterruptedSession): Promise<InterruptResult> {
    // An end under way is the cockpit's own: its outcome is the state the interrupt reads.
    await settlesBeforeAbort(entry.lifecycle.endUnderWay, this.#closing.signal);
    this.#refuseIfClosed(entry.key);
    return interruptTurn(target, {
      interrupting: this.#options.driver.interrupting,
      closing: this.#closing.signal,
      refusal: () => new SessionsClosedError(entry.key),
    });
  }

  /** The session as an interrupt works with it, which clears no input box. */
  #interruptTarget(entry: Entry): InterruptedSession {
    const { key } = entry;
    return {
      key,
      session: () => this.session(key),
      changeListeners: entry.changeListeners,
      withdrawal: entry.withdrawal,
      takesKeys: () => this.#takesInput(entry),
      sendKeys: (keys) => this.#options.host.sendKeys(key, keys),
      gone: () => this.#gone(entry),
    };
  }

  firstPrompt(key: string): Promise<Session> | undefined {
    return this.#entries.get(key)?.firstPrompt.typed;
  }

  forget(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    if (!entry.lifecycle.isEnded) throw wrongState(entry.session);
    this.#entries.delete(key);
    this.#options.asks.forget(key);
    this.#notify();
    return true;
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
  #type(entry: Entry, prompt: string): Promise<TypingOutcome> {
    return this.#throughTypingTerminal(entry, (terminal) =>
      this.#options.driver.typePrompt(prompt, terminal),
    );
  }

  /**
   * Writes into a live session through its checked terminal, the page's
   * terminals' keys held meanwhile: a prompt typed, or the input box
   * cleared.
   *
   * @returns What the write came to; a write the terminal refused, which
   * the driver let through, is `no-input-box`.
   */
  async #throughTypingTerminal<T>(
    entry: Entry,
    write: (terminal: SessionTypingTerminal) => Promise<T>,
  ): Promise<T | 'no-input-box'> {
    const terminal = new SessionTypingTerminal({
      key: entry.key,
      host: this.#options.host,
      readInputBox: (text) => this.#options.driver.readInputBox(text),
      session: () => (this.#takesInput(entry) ? entry.session : undefined),
    });
    entry.typing = terminal;
    const release = this.#options.holds.hold(entry.key);
    try {
      return await write(terminal);
    } catch (error) {
      if (error instanceof TypingStoppedError) return 'no-input-box';
      throw error;
    } finally {
      terminal.close();
      if (entry.typing === terminal) delete entry.typing;
      release();
    }
  }

  receive({ key, path, body }: HookRequest, hold: HookHold): void {
    const entry = this.#entries.get(key);
    if (entry === undefined || !entry.lifecycle.isListened) return;
    const { events, ask } = this.#options.driver.readHook({ key, path, body });
    this.#told(entry, events);
    if (ask !== undefined && this.#opensAsks(entry)) this.#openAsk(entry, { ask, hold });
  }

  /** Follows the session's state from what its agent told, a hook's events or others. */
  #told(entry: Entry, events: readonly DriverEvent[]): void {
    // Closed, the core runs no timer of its own: nothing it hears would be watched.
    if (this.#closing.signal.aborted || !entry.lifecycle.isListened || events.length === 0) return;
    const at = now();
    const settlements: Settlement[] = [];
    const asked: Asked[] = [];
    // One hook is one change: its followers never see a session half told.
    let course: SessionCourse = courseOf(entry);
    for (const event of events) {
      course = { ...course, session: this.#sessionAfterStartUp(entry, course.session, event) };
      // The agent says it ends, the session goes on until its process is
      // gone: declining a dialog may say so too, before any other hook.
      if (event.type === 'ending') entry.agentSaid = event.reason;
      else this.#hear(entry);
      if (event.type === 'conversation') this.#moveTo(entry, event.conversationId);
      const settled = this.#settledBy(entry, course, event);
      settlements.push(...settled);
      course = courseSettled(
        course,
        settled.map(({ id }) => id),
        at,
      );
      if (event.type === 'asked-in-terminal' && this.#opensAsks(entry)) asked.push(event);
      course = courseAfter(course, event, entry.launchedWithPrompt, at);
    }
    this.#take(entry, course);
    // Told once the session changed: what a handler does then starts from it.
    for (const settlement of settlements) this.#tellSettled(settlement);
    for (const ask of asked) this.#openAsk(entry, ask);
    entry.typing?.heard(events);
    if (events.some((event) => event.type === 'ready')) this.#awaitPrompt(entry);
  }

  /**
   * The asks of the session an event settles, taken from those it keeps:
   * the one about a call that finished, or every one, at the end of the
   * batch or the turn, or at its interruption.
   */
  #settledBy(entry: Entry, course: SessionCourse, event: DriverEvent): Settlement[] {
    if (event.type === 'call-finished') {
      return takeAsks(entry, (open) => open.ref === event.ref, 'terminal');
    }
    const by = asksSettledBy(course, event);
    return by === undefined ? [] : takeAsks(entry, () => true, by);
  }

  /**
   * Lets the agent's hook go, with no decision (the agent no longer reads
   * a reply on it), and tells the settlement.
   */
  #tellSettled({ id, open, by }: Settlement): void {
    open.held?.release();
    this.#options.asks.settle(id, by);
  }

  /**
   * Whether an ask of the session's agent opens: while the session is
   * launched or live, not being ended (its process goes within the end's
   * bound), and the core open.
   */
  #opensAsks(entry: Entry): boolean {
    const { phase } = entry.lifecycle;
    return !this.#closing.signal.aborted && (phase === 'launching' || phase === 'live');
  }

  /**
   * Opens an ask of the session's agent: held for the app's answer when a
   * hold is given, else answerable in the terminal only; the session waits
   * on it. An ask a follower answered as it opened is over already.
   */
  #openAsk(entry: Entry, { ask, hold }: Asked): void {
    const opening: { id?: string } = {};
    const held = hold?.(() => this.#heldClosed(entry, opening.id));
    const answering: Answering =
      held === undefined
        ? { answerable: 'terminal' }
        : {
            answerable: 'app',
            handOff: (answer) => held.reply(this.#options.driver.answerReply(ask, answer)),
          };
    const { id } = this.#options.asks.open(entry.key, ask.content, answering);
    opening.id = id;
    if (!this.#options.asks.pending(entry.key).some((each) => each.id === id)) return;
    entry.asks.set(id, held === undefined ? { ref: ask.ref } : { ref: ask.ref, held });
    const course = courseOf(entry);
    const session = this.#sessionPastStartUp(entry, course.session);
    this.#hear(entry);
    const pending = { kind: held === undefined ? 'terminal' : 'ask', id } as const;
    this.#take(entry, courseAsked({ ...course, session }, pending, now()));
  }

  /** The agent closed the hook of a pending ask: it let the ask go (a "No" in the terminal, an Esc). */
  #heldClosed(entry: Entry, id: string | undefined): void {
    if (id === undefined || this.#closing.signal.aborted || !entry.asks.delete(id)) return;
    this.#take(entry, courseSettled(courseOf(entry), [id], now()));
    // Closed by the agent: there is no hook left to let go.
    this.#options.asks.settle(id, 'cancelled');
  }

  /**
   * An ask settled in the registry: by the app's answer, written, or
   * cancelled as the answer found the connection closed. The core's own
   * settlements are no longer among the session's asks.
   */
  #answered({ id, key }: AskSettled): void {
    const entry = this.#entries.get(key);
    if (entry === undefined || !entry.asks.delete(id)) return;
    this.#take(entry, courseSettled(courseOf(entry), [id], now()));
  }

  /**
   * Settles every pending ask of a session that ended, `cancelled`, each
   * hook still open let go.
   */
  #cancelAsks(entry: Entry): void {
    for (const settlement of takeAsks(entry, () => true, 'cancelled')) {
      this.#tellSettled(settlement);
    }
  }

  /** Takes the course the session is on now. */
  #take(entry: Entry, { session, ...told }: SessionCourse): void {
    entry.told = told;
    this.#update(entry, session);
    if (!isInTurn(entry.session)) stopFollowingTheConversationsLeft(entry);
    entry.withdrawal.follow(entry.session.state === 'busy' ? told.withdrawablePrompt : undefined);
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
    this.#stopHearingAnswers();
    for (const entry of this.#entries.values()) {
      // Settled by nobody, told to nobody: the listener drops their connections.
      entry.asks.clear();
      entry.typing?.close();
      entry.firstPrompt.stop();
      stopReadingTheScreen(entry);
      entry.withdrawal.stop();
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
    const entry: Entry = {
      key,
      directory,
      environment: this.#options.environment(),
      conversationId,
      conversationIsNew: resume !== true,
      launchedWithPrompt: prompt !== undefined,
      firstPrompt: new FirstPrompt(toType),
      session: { key, state: 'starting', since: now() },
      told: {},
      changeListeners: new Set(),
      withdrawal: new WithdrawnWatch({
        read: () => this.#readScreenText(key),
        signs: this.#options.driver.screenStateSigns,
        // Not while the cockpit kills it: its hooks are not heard either.
        onWithdrawn: () => {
          if (!entry.lifecycle.isListened) return;
          this.#take(entry, courseWithdrawn(courseOf(entry), now()));
        },
      }),
      lifecycle: new SessionLifecycle('reserved'),
      heard: false,
      stopFollowingLeft: [],
      asks: new Map(),
      ...(replaces === undefined ? {} : { replaces }),
    };
    return entry;
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
    return event.type === 'ending' ? session : this.#sessionPastStartUp(entry, session);
  }

  /** The session once the agent was heard past its start: no longer waiting on a start-up dialog. */
  #sessionPastStartUp(entry: Entry, session: Session): Session {
    if (entry.heard || session.state !== 'waiting') return session;
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
      entry.stoppedTasks = tasksKnown(courseOf(entry));
      entry.firstPrompt.stop();
      stopReadingTheScreen(entry);
      entry.withdrawal.stop();
      stopFollowingEveryConversation(entry);
      this.#watch.unwatch(entry.key);
      this.#options.hooks.revoke(entry.key);
      const canResume = await this.#options.driver
        .canResume(conversationOf(entry))
        // A conversation the driver cannot find is one it cannot resume.
        .catch(() => false);
      const { key } = entry;
      return () => {
        this.#update(entry, { key, state: 'ended', since: now(), canResume, ...endOf(entry) });
        this.#cancelAsks(entry);
      };
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
    entry.withdrawal.changed(session);
    this.#notify();
    for (const listener of entry.changeListeners) listener(session);
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
  const cockpits = entry.endedBecause ?? entry.endAskedBecause;
  if (cockpits !== undefined) return { reason: cockpits };
  const declined = entry.heard ? undefined : entry.startUp?.dialogShown;
  if (declined === undefined) return { reason: entry.agentSaid ?? 'lost' };
  return declined.dialog === undefined
    ? { reason: 'declined' }
    : { reason: 'declined', dialog: declined.dialog };
}

/** Removes the session's pending asks that `picked` chooses, to settle them. */
function takeAsks(
  entry: Entry,
  picked: (open: OpenAsk) => boolean,
  by: Settlement['by'],
): Settlement[] {
  const taken = [...entry.asks]
    .filter(([, open]) => picked(open))
    .map(([id, open]) => ({ id, open, by }));
  for (const { id } of taken) entry.asks.delete(id);
  return taken;
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

function courseOf({ session, told }: Entry): SessionCourse {
  return { ...told, session };
}

function now(): string {
  return new Date().toISOString();
}
