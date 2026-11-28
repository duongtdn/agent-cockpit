/**
 * The units of work: what a run, a send, an open, an interrupt, an end and
 * a remove do in each state of a key's session, on top of the sessions
 * core — the conversation resumed or started anew, a live session ended
 * first, a prompt typed, the cap on live sessions — and the records that
 * keep each key's conversations, history, folder and launch settings.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CockpitError } from '../../shared/cockpit-error.js';
import type {
  BackgroundTask,
  EndedSession,
  EndReason,
  EndResult,
  HistoryEntry,
  InterruptResult,
  OpenOptions,
  OpenResult,
  RemoveResult,
  RunOptions,
  RunResult,
  SendResult,
  Session,
  SessionState,
} from '../../shared/session.js';
import type { Driver, DriverSettings } from '../driver.js';
import { checkRecordedFolder, type JobFolder } from '../job-folders.js';
import { refuseUnfitPrompt } from '../prompt-length.js';
import type { RecordStore, UnitRecord } from '../state/records.js';
import { removeUnitFiles } from '../state/unit-files.js';
import { Followers } from './followers.js';
import { createIdleTimeout, type IdleTimeout } from './idle-timeout.js';
import type { JobRun, JobRuns } from './job-runs.js';
import { type FreeTurn, KeyQueue } from './key-queue.js';
import {
  type EndToCarryOut,
  type SessionFolders,
  type Sessions,
  SessionsClosedError,
  wrongState,
} from './sessions.js';

/** What the units of work work with. */
export interface UnitsOfWorkOptions {
  /** The sessions core, which launches, types into and ends the sessions. */
  readonly sessions: Sessions;
  /** The records of the units of work, loaded. */
  readonly records: RecordStore;
  /** The app's jobs, as a run reads them. */
  readonly jobs: JobRuns;
  /** What the units of work ask the driver: a launch's settings, and whether a conversation is kept. */
  readonly driver: Pick<Driver, 'launchSettings' | 'canResume'>;
  /**
   * Gives the environment a launch starts from, as the sessions core is
   * given it: where the agent keeps its conversations may follow from it.
   */
  readonly environment: () => Readonly<Record<string, string>>;
  /**
   * The sessions' folders, which a remove deletes with the key's record:
   * the sessions core's own. The units of work run a remove on the key's
   * queue, as every launch that prepares a folder through the core, which
   * is what keeps a folder from being deleted under a launch.
   */
  readonly folders: Pick<SessionFolders, 'remove'>;
  /**
   * The most sessions live at once; no cap when left out. At the cap, a
   * start ends the `idle` session idle longest that has no background
   * task, no terminal attached and no operation under way on its key,
   * else fails `session-cap-reached`. A session it is ending takes no send
   * or run until it is gone.
   */
  readonly maxSessions?: number;
  /**
   * How long a session stays `idle` before it is ended, `reason:
   * 'idle-timeout'`, in milliseconds: an integer from 1 to 2,147,483,647;
   * no session is ended for idleness when left out. The time counts from
   * when the session became `idle`; any other state, and every new `idle`,
   * starts it again. A session held as the cap holds one — with a
   * background task, a terminal attached (a count that fails counts as
   * one) or an operation under way on its key — is not ended then, and is
   * tried again one full timeout later. The state is read once the
   * terminals are counted, and its end begins at once: a turn that begins
   * after that ends with it; a session found in another `idle` than the
   * one timed is timed from its new one. An end that fails is written to
   * `console.error`, and the session tried again one full timeout later.
   * {@link openUnitsOfWork} rejects any other value with a `RangeError`.
   */
  readonly idleTimeoutMs?: number;
}

/**
 * The units of work of the app: each key's session, as its runs, sends and
 * opens drive it, and its record. The operations of one key run one at a
 * time, each on the state the one before left.
 */
export interface UnitsOfWork {
  /**
   * Runs a job on the unit of work its arguments name.
   *
   * | State | Run |
   * |---|---|
   * | no record | Starts the agent with the prompt, at launch. |
   * | `ended` | Resumes the conversation with the prompt; starts a new one when the job is `fresh` (`fresh`), or when the agent no longer keeps it (`conversation-gone`). |
   * | `idle` | Types the prompt (`sent`). Launched with other settings: ended (`restarted`), then resumed with the run's settings and prompt (`settings-changed`). |
   * | `waiting`, `starting`, `busy` | Refused `wrong-state`. |
   *
   * A job with no prompt starts or resumes with none, and on a live
   * session has nothing to send (`nothing-to-send`), unless its settings
   * differ from an `idle` session's. With `fresh`, a new conversation
   * (`fresh-on-request`), a live session ended first, `starting` refused.
   * A prompt too long for the agent's command line is typed once it
   * started: the run settles once the agent took it, the key left to the
   * calls that follow while a start-up dialog waits for a person. A run
   * that fails with its session live is not kept in the key's history,
   * which keeps its arguments as they were at the call.
   *
   * @param jobId - The job's id.
   * @param args - The arguments, unchecked.
   * @param options - `fresh`.
   * @returns What the run did, and the state the session is in.
   * @throws `CockpitError` what reading the job's run throws (`unknown-job`,
   * `invalid-arguments`, `not-a-choice`, `invalid-options`,
   * `folder-outside-app`); `invalid-arguments` for a prompt that is empty
   * or only whitespace; `prompt-too-long`; `folder-changed`;
   * `wrong-state`; `prompt-not-taken`; `session-cap-reached`; and what a
   * launch throws. `TypeError` for arguments the key's history cannot keep
   * (a `BigInt`, a cycle), before anything is launched.
   */
  run(jobId: string, args: unknown, options?: RunOptions): Promise<RunResult>;
  /**
   * Sends a prompt to a unit of work: typed into its `idle` session (`sent`),
   * or its `ended` one resumed with the prompt and the settings of its last
   * run, read again with every check of a run (`resumed`; `started`,
   * `conversation-gone`). A send never begins a unit of work.
   *
   * @param key - The unit of work's key.
   * @param prompt - The prompt.
   * @returns What the send did, and the state the session is in.
   * @throws `CockpitError` `invalid-arguments` for a prompt that is empty or
   * only whitespace; `prompt-too-long`; `unknown-key` for a key with
   * no record, or whose history keeps no run to resume it with;
   * `wrong-state` on `starting`, `busy`, `waiting`, or a session being ended;
   * `prompt-not-taken`; what reading its last run throws (`unknown-job`
   * when the job is gone); `folder-changed`; `session-cap-reached`; and
   * what a launch throws.
   */
  send(key: string, prompt: string): Promise<SendResult>;
  /**
   * Opens a unit of work to type in: its `ended` session resumed with no
   * prompt and the settings of its last run, read again with every check
   * of a run. A live session, or a key with no record, has nothing to
   * open. With `fresh`, a new conversation, a live session ended first.
   *
   * @param key - The unit of work's key.
   * @param options - `fresh`.
   * @returns What the open did, and the state the session is in.
   * @throws `CockpitError` `wrong-state` with `fresh` on `starting`;
   * `unknown-key` when its history keeps no run; what reading its last run
   * throws (`unknown-job` when the job is gone);
   * `folder-changed`; `session-cap-reached`; and what a launch throws.
   */
  open(key: string, options?: OpenOptions): Promise<OpenResult>;
  /**
   * Interrupts the turn of a unit of work's session, once the operations
   * asked before it on the key settled: a send under way is waited for,
   * and the turn it began is the one interrupted. The sessions core's
   * `interrupt` does the rest, once, on a `busy` session or one waiting on
   * more than the terminal: the driver's reply to its oldest ask the app
   * can answer, no key pressed, every ask of the turn settled `cancelled`;
   * else the driver's keys for an ask answerable in the terminal only (one
   * Esc); else its keys for a `busy` turn (one Esc). Then confirmed `idle`
   * within the driver's bound; nothing pressed where no turn runs.
   *
   * @param key - The unit of work's key.
   * @returns `interrupted` once the session is `idle`;
   * `nothing-to-interrupt` with the session's state when no turn runs
   * (`idle`, `ended`, waiting in the terminal) or the session ended
   * meanwhile, with none for a key with no record.
   * @throws `CockpitError` `wrong-state` on `starting`;
   * `interrupt-unconfirmed` with the key and the last state when the
   * session was not seen `idle` in time. What the host fails with.
   * `SessionsClosedError` once the units of work or the core are closed
   * first.
   */
  interrupt(key: string): Promise<InterruptResult>;
  /**
   * Ends a unit of work's session, once the operations asked before it on
   * the key settled: its agent's process ended, its conversation and
   * record kept, `ended` with `reason: 'app'`.
   *
   * | State | End |
   * |---|---|
   * | no record, `ended` | Nothing to end. |
   * | `starting` | Refused `wrong-state`. |
   * | `idle`, `waiting` in the terminal only (a start-up dialog, a panel) | Ended at once, no key pressed. |
   * | `busy`, `waiting` on anything else | Its turn interrupted first, as `interrupt` does, then ended whether or not the interrupt was confirmed. A prompt the interrupt withdraws is left in the box: no key is pressed once the end was asked but the interrupt's own. |
   *
   * A session being ended already (the cap's end, a restart's, the idle
   * timeout's) has that end awaited, its reason kept. If that end's kill
   * fails, the session is live again, and this end then ends it as the
   * table says for its state then: a `busy` one has its turn interrupted
   * first.
   *
   * @param key - The unit of work's key.
   * @returns `ended` once the session's process is gone, with the
   * background tasks known running as it went, stopped with it (empty when
   * none ran); `nothing-to-end` with the session's state, none for a key
   * with no record.
   * @throws `CockpitError` `wrong-state` on `starting`.
   * @throws `SessionHostError` when the host cannot kill a session that
   * outlived the driver's bound: the session is left live, and a later end
   * may kill it. It has no code: as every failure of the machine, it
   * reaches the browser as a 500 with no body, and the app's `error`
   * handlers as `internal-failure`.
   * @throws `SessionsClosedError` once the units of work or the core are
   * closed first, or the core is closed before the end settles.
   */
  end(key: string): Promise<EndResult>;
  /**
   * Removes a unit of work, once the operations asked before it on the key
   * settled: what the cockpit wrote for it — its session's folder, then its
   * record, if it has one — deleted, and the key forgotten. The key is unknown from then
   * on: it is no longer listed, and its next run starts a new
   * conversation. The agent's own files, its transcripts, are left where
   * the agent keeps them.
   *
   * | State | Remove |
   * |---|---|
   * | no record, no session in this process | Nothing to remove. |
   * | `starting` | Refused `wrong-state`. |
   * | `idle`, `busy`, `waiting` | Ended first as `end` ends it (`reason: 'app'`), then removed. |
   * | `ended` | Removed. |
   *
   * A key listed with no record — a first launch that failed, a session
   * whose record could not be written — is removed as any other: its
   * session's folder, its hook token in it, is the cockpit's to delete.
   *
   * A remove that fails keeps the key's record: the key stays known, and a
   * remove asked again finishes.
   *
   * @param key - The unit of work's key.
   * @returns `removed`, with the background tasks stopped with the session
   * ended first, absent when none ran; `nothing-to-remove` for a key with
   * no record and no session in this process.
   * @throws `CockpitError` `wrong-state` on `starting`.
   * @throws `SessionHostError` when the host cannot kill the session, as
   * `end` throws it: the session is left live, its record kept.
   * @throws The file system's error when a file cannot be deleted: the
   * session ended, its record kept.
   * @throws `SessionsClosedError` once the units of work or the core are
   * closed first, or are closed before anything is deleted.
   */
  remove(key: string): Promise<RemoveResult>;
  /**
   * Lists the units of work: each recorded key's session with its record,
   * `ended` when no session of this process lives, in the order the keys
   * were first recorded; then any session not recorded yet.
   *
   * @returns The sessions.
   */
  list(): Session[];
  /**
   * Follows the units of work: the listener gets the list now, then again
   * at every change of a session or a record. A listener that throws stops
   * neither the others nor the change: what it threw goes to
   * `console.error`.
   *
   * @param listener - Called with the list.
   * @returns A function that stops the following.
   */
  follow(listener: (sessions: readonly Session[]) => void): () => void;
  /**
   * Closes the units of work: every operation that has not begun, waiting
   * for its key's turn or asked from now on, is rejected at once with
   * `SessionsClosedError`, and does nothing; one under way makes no folder
   * and writes no record from now on. The sessions core is no longer
   * followed, and no follower is told anything more.
   *
   * @returns A promise fulfilled once every write of a record, and every
   * deletion of a key's files, under way is done, whatever its outcome:
   * none is made after it.
   */
  close(): Promise<void>;
}

/**
 * Opens the units of work: each key recorded with no session in this
 * process is listed `ended`, the driver asked whether it still keeps its
 * conversation.
 *
 * @param options - See {@link UnitsOfWorkOptions}.
 * @returns The units of work.
 * @throws `RangeError` when `idleTimeoutMs` is not an integer from 1 to
 * 2,147,483,647: the cockpit's options refuse such a value first.
 */
export async function openUnitsOfWork(options: UnitsOfWorkOptions): Promise<UnitsOfWork> {
  const since = new Date().toISOString();
  const loaded = new Map<string, EndedSession>();
  for (const record of options.records.list()) {
    if (options.sessions.session(record.key) !== undefined) continue;
    const canResume = await keepsConversation(options, record);
    // The cockpit was not running when its session went: nothing tells why.
    loaded.set(record.key, { key: record.key, state: 'ended', since, canResume, reason: 'lost' });
  }
  return new Units(options, loaded);
}

async function keepsConversation(
  { jobs, driver, environment }: UnitsOfWorkOptions,
  { conversationId, directory }: UnitRecord,
): Promise<boolean> {
  try {
    const folder = await jobs.recordedFolder(directory);
    return await driver.canResume({
      conversationId,
      directory: folder.path,
      environment: environment(),
    });
  } catch {
    return false;
  }
}

/** Why a new conversation is started for a key that had one. */
type StartReason = 'fresh' | 'fresh-on-request' | 'conversation-gone';

/** How a launch takes up the key's conversation: resumes the recorded one, or starts a new one. */
type Take =
  | { readonly kind: 'resume'; readonly reason?: 'settings-changed' }
  | { readonly kind: 'new'; readonly reason?: StartReason };

/** What a launch of a unit of work's session is made of. */
interface Plan {
  readonly key: string;
  /** The run whose job's settings and folder the session launches with. */
  readonly run: JobRun;
  /** The prompt passed: the run's, the send's, none for an open. */
  readonly prompt: string | undefined;
  readonly take: Take;
  /** Why the key's live session is ended first, when it is. */
  readonly endFirst?: EndReason;
  /** What the key's history keeps of the operation; none for a send. */
  readonly history?: Operation;
  /**
   * Frees the key's turn: a launch whose first prompt waits behind a
   * start-up dialog leaves the key to the calls that follow.
   */
  readonly freeTurn: FreeTurn;
}

/** A run or an open, as the key's history keeps it before it is known what it did. */
type Operation = Pick<HistoryEntry, 'operation' | 'jobId' | 'args' | 'at'>;

/** A launch admitted: the conversation it took up, and the tasks the session it replaced stopped. */
interface Admitted {
  readonly take: Take;
  readonly conversationId: string;
  /**
   * The conversation the key's session worked in before this launch, as it
   * ended: one its agent moved to (a `/clear`) may be known to no record.
   */
  readonly before: string | undefined;
  readonly stoppedTasks: readonly BackgroundTask[];
  /** The launch, settling once the session left `starting`. */
  readonly launching: Promise<Session>;
}

/** What a launch of a unit of work did. */
interface Launched {
  readonly take: Take;
  readonly state: SessionState;
  readonly stoppedTasks: readonly BackgroundTask[];
}

/** The one key of the queue every admission runs on: they run one at a time, cockpit-wide. */
const ADMISSION = 'admission';

class Units implements UnitsOfWork {
  readonly #sessions: Sessions;
  readonly #records: RecordStore;
  readonly #jobs: JobRuns;
  readonly #options: UnitsOfWorkOptions;
  readonly #loaded: Map<string, EndedSession>;
  /** Aborted by the close: one signal every wait of the queues races against. */
  readonly #closing = new AbortController();
  readonly #queue = new KeyQueue(this.#closing.signal, closedRefusal);
  readonly #admissions = new KeyQueue(this.#closing.signal, closedRefusal);
  readonly #followers = new Followers();
  readonly #stops: (() => void)[];
  /** The writes of the state folder under way, each settled whatever its outcome: what the close waits for. */
  readonly #writes = new Set<Promise<void>>();
  /** Ends the sessions left `idle` for the app's timeout; none when the app set none. */
  readonly #idleTimeout: IdleTimeout | undefined;

  constructor(options: UnitsOfWorkOptions, loaded: Map<string, EndedSession>) {
    this.#options = options;
    this.#sessions = options.sessions;
    this.#records = options.records;
    this.#jobs = options.jobs;
    this.#loaded = loaded;
    this.#idleTimeout =
      options.idleTimeoutMs === undefined
        ? undefined
        : // An end that fails goes to `console.error`, its default, as what a follower throws does.
          createIdleTimeout({
            timeoutMs: options.idleTimeoutMs,
            tryEnd: (key, since) => this.#endForIdleness(key, since),
          });
    this.#stops = [
      this.#sessions.follow((list) => {
        for (const session of list) this.#idleTimeout?.observe(session);
        this.#notify();
      }),
      this.#sessions.onConversation((key, conversationId, left) => {
        void this.#queue.run(key, () => this.#moved(key, conversationId, left)).catch(() => {});
      }),
    ];
  }

  async run(jobId: string, args: unknown, options: RunOptions = {}): Promise<RunResult> {
    const at = now();
    // Read at once, so that the run takes its place among its key's operations as it is asked.
    const reading = this.#jobs.read(jobId, args);
    if (reading.prompt !== undefined) refuseUnfitPrompt(reading.prompt);
    const operation: Operation = { operation: 'run', jobId, args: asRecorded(args), at };
    return this.#queue.run(reading.key, async (freeTurn) =>
      this.#run(await reading.checked(), options.fresh === true, operation, freeTurn),
    );
  }

  async send(key: string, prompt: string): Promise<SendResult> {
    refuseUnfitPrompt(prompt);
    return this.#queue.run(key, (freeTurn) => this.#send(key, prompt, freeTurn));
  }

  async open(key: string, options: OpenOptions = {}): Promise<OpenResult> {
    const at = now();
    return this.#queue.run(key, (freeTurn) =>
      this.#open(key, options.fresh === true, at, freeTurn),
    );
  }

  async interrupt(key: string): Promise<InterruptResult> {
    return this.#queue.run(key, () => this.#interrupt(key));
  }

  async #interrupt(key: string): Promise<InterruptResult> {
    if (this.#sessions.session(key) !== undefined) return this.#sessions.interrupt(key);
    return { action: 'nothing-to-interrupt', ...this.#recordedState(key) };
  }

  async end(key: string): Promise<EndResult> {
    return this.#queue.run(key, () => this.#end(key));
  }

  async #end(key: string): Promise<EndResult> {
    if (this.#sessions.session(key) === undefined) {
      return { action: 'nothing-to-end', ...this.#recordedState(key) };
    }
    return this.#sessions.interruptAndEnd(key, 'app');
  }

  async remove(key: string): Promise<RemoveResult> {
    return this.#queue.run(key, () => this.#remove(key));
  }

  async #remove(key: string): Promise<RemoveResult> {
    if (this.#records.get(key) === undefined && this.#sessions.session(key) === undefined) {
      return { action: 'nothing-to-remove' };
    }
    const end = await this.#sessions.interruptAndEnd(key, 'app');
    await this.#tracked(key, () =>
      removeUnitFiles(key, { records: this.#records, folders: this.#options.folders }),
    );
    this.#loaded.delete(key);
    this.#idleTimeout?.forget(key);
    // The core tells its followers, these units of work among them, when it forgets a session.
    if (!this.#sessions.forget(key)) this.#notify();
    return {
      action: 'removed',
      ...stoppedTasksOf({ stoppedTasks: end.action === 'ended' ? end.stoppedTasks : [] }),
    };
  }

  /** The state of a key with no session in this process: `ended` when it is recorded, none when not. */
  #recordedState(key: string): { state?: SessionState } {
    const record = this.#records.get(key);
    return record === undefined ? {} : { state: this.#sessionOf(record).state };
  }

  list(): Session[] {
    const recorded = this.#records.list();
    const keys = new Set(recorded.map((record) => record.key));
    return [
      ...recorded.map((record) => withRecord(this.#sessionOf(record), record)),
      ...this.#sessions.list().filter((session) => !keys.has(session.key)),
    ];
  }

  follow(listener: (sessions: readonly Session[]) => void): () => void {
    return this.#followers.add(listener, this.list());
  }

  close(): Promise<void> {
    this.#idleTimeout?.close();
    this.#closing.abort();
    for (const stop of this.#stops.splice(0)) stop();
    this.#followers.clear();
    return Promise.all(this.#writes).then(() => undefined);
  }

  /** Writes a key's record, as every write of the state folder is made: see {@link #tracked}. */
  async #write(record: UnitRecord): Promise<void> {
    await this.#tracked(record.key, () => this.#records.put(record));
  }

  /**
   * Makes a write of the key's files in the state folder — a record put,
   * the key's files deleted — unless the units of work are closed, and keeps
   * it for the close to wait for: the app's lock is released once the close
   * settles, and the state folder may be another process's then.
   */
  async #tracked(key: string, write: () => Promise<void>): Promise<void> {
    this.#refuseIfClosed(key);
    const written = write();
    const settled = written.catch(() => undefined);
    this.#writes.add(settled);
    void settled.then(() => this.#writes.delete(settled));
    await written;
  }

  #refuseIfClosed(key: string): void {
    if (this.#closing.signal.aborted) throw new SessionsClosedError(key);
  }

  async #run(
    run: JobRun,
    fresh: boolean,
    history: Operation,
    freeTurn: FreeTurn,
  ): Promise<RunResult> {
    const { key } = run;
    const record = this.#records.get(key);
    const session = this.#liveSession(key);
    const launch = (take: Take, endFirst?: EndReason) =>
      this.#launch({
        key,
        run,
        prompt: run.prompt,
        take,
        ...(endFirst === undefined ? {} : { endFirst }),
        history,
        freeTurn,
      });
    if (fresh && session?.state === 'starting') throw wrongState(session);
    if (fresh || record === undefined) {
      const take: Take =
        record === undefined ? { kind: 'new' } : { kind: 'new', reason: 'fresh-on-request' };
      return startedOrResumed(await launch(take, session === undefined ? undefined : 'restarted'));
    }
    if (session === undefined) {
      if (run.fresh) return startedOrResumed(await launch({ kind: 'new', reason: 'fresh' }));
      checkRecordedFolder(record.directory, run.folder);
      return startedOrResumed(await launch({ kind: 'resume' }));
    }
    if (session.state === 'idle') {
      checkRecordedFolder(record.directory, run.folder);
      if (!isDeepStrictEqual(record.launchSettings, this.#settingsOf(run))) {
        return startedOrResumed(
          await launch({ kind: 'resume', reason: 'settings-changed' }, 'restarted'),
        );
      }
    }
    if (run.prompt === undefined) return { action: 'nothing-to-send', state: session.state };
    if (session.state !== 'idle') throw wrongState(session);
    const typed = await this.#sessions.send(key, run.prompt);
    await this.#recordSent(record, history);
    return { action: 'sent', state: typed.state };
  }

  async #send(key: string, prompt: string, freeTurn: FreeTurn): Promise<SendResult> {
    const record = this.#records.get(key);
    if (record === undefined) {
      throw new CockpitError('unknown-key', `No unit of work has the key ${JSON.stringify(key)}.`, {
        key,
      });
    }
    const session = this.#liveSession(key);
    if (session !== undefined) {
      if (session.state !== 'idle') throw wrongState(session);
      const typed = await this.#sessions.send(key, prompt);
      return { action: 'sent', state: typed.state };
    }
    const run = await this.#lastRun(record);
    checkRecordedFolder(record.directory, run.folder);
    const { take, state } = await this.#launch({
      key,
      run,
      prompt,
      take: { kind: 'resume' },
      freeTurn,
    });
    return take.kind === 'resume'
      ? { action: 'resumed', state }
      : { action: 'started', reason: 'conversation-gone', state };
  }

  async #open(key: string, fresh: boolean, at: string, freeTurn: FreeTurn): Promise<OpenResult> {
    const record = this.#records.get(key);
    if (record === undefined) return { action: 'nothing-to-open' };
    const session = this.#liveSession(key);
    if (session !== undefined && !fresh) return { action: 'nothing-to-open', state: session.state };
    if (session?.state === 'starting') throw wrongState(session);
    const run = await this.#lastRun(record);
    if (!fresh) checkRecordedFolder(record.directory, run.folder);
    const launched = await this.#launch({
      key,
      run,
      prompt: undefined,
      take: fresh ? { kind: 'new', reason: 'fresh-on-request' } : { kind: 'resume' },
      ...(session === undefined ? {} : { endFirst: 'restarted' }),
      history: { operation: 'open', jobId: run.jobId, args: run.args, at },
      freeTurn,
    });
    const { take, state } = launched;
    if (take.kind === 'resume') return { action: 'resumed', state };
    return {
      action: 'started',
      reason: take.reason === 'conversation-gone' ? 'conversation-gone' : 'fresh-on-request',
      state,
      ...stoppedTasksOf(launched),
    };
  }

  /**
   * The key's last run, read again with every check of a run: the job as
   * the app defines it now, with the recorded arguments.
   */
  async #lastRun(record: UnitRecord): Promise<JobRun> {
    const last = record.history.at(-1);
    if (last === undefined) {
      throw new CockpitError('unknown-key', `The unit of work ${record.key} has no run.`, {
        key: record.key,
      });
    }
    return this.#jobs.read(last.jobId, last.args).checked();
  }

  /**
   * Launches a unit of work's session as the plan says, then records it. A
   * resumed conversation the agent turns out not to keep — it exits at
   * once, with nothing kept — is started anew, `conversation-gone`: one
   * launch for the record. A launch whose first prompt waits behind a
   * start-up dialog is parked.
   */
  async #launch(plan: Plan): Promise<Launched> {
    this.#refuseIfClosed(plan.key);
    const folder = await this.#jobs.makeFolder(plan.run.folder);
    let admitted = await this.#admit(plan, folder);
    let session = await this.#launched(plan, folder, admitted);
    if (admitted.take.kind === 'resume' && session.state === 'ended' && !session.canResume) {
      const { stoppedTasks } = admitted;
      const anew: Plan = {
        ...plan,
        take: { kind: 'new', reason: 'conversation-gone' },
      };
      admitted = { ...(await this.#admit(anew, folder)), stoppedTasks, before: admitted.before };
      session = await this.#launched(anew, folder, admitted);
    }
    const firstPrompt =
      session.state === 'waiting' ? this.#sessions.firstPrompt(plan.key) : undefined;
    if (firstPrompt !== undefined) return this.#parked(plan, folder, admitted, firstPrompt);
    await this.#record(plan, folder, admitted);
    return { take: admitted.take, state: session.state, stoppedTasks: admitted.stoppedTasks };
  }

  /**
   * Waits, with the key's turn freed, for a first prompt typed after the
   * start whose launch waits behind a start-up dialog: the session is
   * recorded at once, as the other calls on the key act on it meanwhile,
   * and the operation once the agent took the prompt or the session ended
   * — not when the typing fails. Nothing answers the dialog but a person,
   * so the operation settles only then.
   */
  async #parked(
    plan: Plan,
    folder: JobFolder,
    admitted: Admitted,
    firstPrompt: Promise<Session>,
  ): Promise<Launched> {
    await this.#record(withoutOperation(plan), folder, admitted);
    plan.freeTurn();
    const session = await firstPrompt;
    const { history } = plan;
    if (history !== undefined) {
      const entry = historyEntryOf(history, admitted.take, admitted.conversationId);
      await this.#queue.run(plan.key, () => this.#recordOperation(plan.key, entry));
    }
    return { take: admitted.take, state: session.state, stoppedTasks: admitted.stoppedTasks };
  }

  /**
   * Records an operation that settled after its key's turn was freed, in
   * the key's history in the order the operations were asked — only in
   * the record of the unit of work it ran in, one that names its
   * conversation: the unit of work may have been removed meanwhile, and
   * its key recorded anew by a run asked after the remove.
   */
  async #recordOperation(key: string, entry: HistoryEntry): Promise<void> {
    const record = this.#records.get(key);
    if (record === undefined || !namesConversation(record, entry.conversationId)) return;
    const history = [...record.history];
    const later = history.findIndex((each) => each.at > entry.at);
    history.splice(later === -1 ? history.length : later, 0, entry);
    await this.#write({ ...record, history });
    this.#notify();
  }

  /**
   * Waits for an admitted launch. One that fails with its session live (a
   * first prompt typed after the start, not taken; the cockpit closed
   * before it settled) is recorded all the same, since the session works
   * in its conversation — but not in the key's history: the operation did
   * not do what it asked.
   */
  async #launched(plan: Plan, folder: JobFolder, admitted: Admitted): Promise<Session> {
    try {
      return await admitted.launching;
    } catch (error) {
      if (this.#liveSession(plan.key) !== undefined) {
        await this.#record(withoutOperation(plan), folder, admitted);
      }
      throw error;
    }
  }

  /**
   * Admits a launch, one admission at a time cockpit-wide: the key's live
   * session ended first when the plan says so, the conversation to take up
   * chosen once it has, room made under the cap, and the launch begun, its
   * key taken, before the next admission counts the live sessions. The
   * turn of a session ended first is interrupted, as an app's end
   * interrupts it, before the admission: that frees no room, and no other
   * key's start waits behind it. The key's turn is held meanwhile, so no
   * other operation acts on the session, and the cap passes over it.
   */
  async #admit(plan: Plan, folder: JobFolder): Promise<Admitted> {
    const { endFirst } = plan;
    const ending =
      endFirst === undefined ? undefined : await this.#sessions.interruptToEnd(plan.key, endFirst);
    try {
      return await this.#admitted(plan, folder, ending);
    } finally {
      ending?.abandon();
    }
  }

  /** Admits a launch once the turn of the session it replaces, if any, was interrupted: see {@link #admit}. */
  #admitted(plan: Plan, folder: JobFolder, ending: EndToCarryOut | undefined): Promise<Admitted> {
    return this.#admissions.run(ADMISSION, async () => {
      const stoppedTasks = (await ending?.end()) ?? [];
      const before = this.#sessions.conversationOf(plan.key);
      const { take, conversationId } = await this.#takeUp(plan, folder);
      await this.#makeRoom(plan.key);
      // Closed meanwhile: the sessions core is closed only once the close settled, and would still start one.
      this.#refuseIfClosed(plan.key);
      const launching = this.#sessions.launch({
        key: plan.key,
        directory: folder.path,
        conversationId,
        ...(take.kind === 'resume' ? { resume: true } : {}),
        ...(plan.prompt === undefined ? {} : { prompt: plan.prompt }),
        ...(plan.run.part === undefined ? {} : { part: plan.run.part }),
      });
      launching.catch(() => {});
      return { take, conversationId, before, stoppedTasks, launching };
    });
  }

  /**
   * The conversation a launch takes up: a new one, or the key's current
   * one when the agent still keeps it — a conversation it no longer keeps
   * (no transcript: deleted, or never given a prompt) is started anew.
   * Asked once the key's session ended, when the agent has written all it
   * keeps.
   */
  async #takeUp(plan: Plan, folder: JobFolder): Promise<{ take: Take; conversationId: string }> {
    const current =
      this.#sessions.conversationOf(plan.key) ?? this.#records.get(plan.key)?.conversationId;
    if (plan.take.kind === 'new' || current === undefined) {
      return {
        take: plan.take.kind === 'new' ? plan.take : { kind: 'new' },
        conversationId: randomUUID(),
      };
    }
    const kept = await this.#options.driver
      .canResume({
        conversationId: current,
        directory: folder.path,
        environment: this.#options.environment(),
      })
      .catch(() => false);
    if (kept) return { take: plan.take, conversationId: current };
    return { take: { kind: 'new', reason: 'conversation-gone' }, conversationId: randomUUID() };
  }

  /**
   * Makes room for a start under the cap: ends the `idle` session idle
   * longest that the idle timeout could end (no background task, no
   * terminal attached) and no operation of its key is acting on, until a
   * place is free.
   */
  async #makeRoom(key: string): Promise<void> {
    const cap = this.#options.maxSessions;
    if (cap === undefined) return;
    for (;;) {
      const live = this.#sessions.liveKeys().filter((each) => each !== key);
      if (live.length < cap) return;
      if (!(await this.#endIdlest(live))) {
        throw new CockpitError(
          'session-cap-reached',
          `${live.length} sessions live, the most the app allows, and none can be ended to make room.`,
          { cap, live },
        );
      }
    }
  }

  /**
   * Ends the endable session idle longest, its key's turn taken while it is
   * checked again and its end begun, without waiting for the turn: the
   * operation that holds it may be waiting for the admission this runs in.
   * A key taken meanwhile, or no longer endable, gives way to the next.
   *
   * @returns Whether a session was ended.
   */
  async #endIdlest(keys: readonly string[]): Promise<boolean> {
    for (const key of await this.#endableByIdleness(keys)) {
      const begun = await this.#queue.tryRun(key, () =>
        this.#beginEndIfEndable(key, 'session-cap'),
      );
      if (begun?.endability !== 'endable') continue;
      await begun.ended;
      return true;
    }
    return false;
  }

  /**
   * The idle timeout's try of a session in the `idle` begun at `since`:
   * ended as the cap would end it, when the cap could and the session is
   * still in that `idle`. A key whose turn is taken is held; the units of
   * work closed meanwhile end nothing more, and their idle timeout tries
   * nothing more either.
   */
  async #endForIdleness(key: string, since: string): Promise<'ended' | 'held' | 'not-idle'> {
    try {
      const begun = await this.#queue.tryRun(key, () =>
        this.#beginEndIfEndable(key, 'idle-timeout', since),
      );
      if (begun === undefined) return 'held';
      if (begun.endability !== 'endable') return begun.endability;
      await begun.ended;
      return 'ended';
    } catch (error) {
      if (error instanceof SessionsClosedError) return 'held';
      throw error;
    }
  }

  /**
   * Begins the end of a session still endable, for the reason given; with
   * `since`, only in the `idle` begun then. Its end is handed back
   * unawaited, so that the key's turn is freed once the end is begun: an
   * operation on the key then finds it being ended, and is refused, or
   * joins that end.
   */
  #beginEndIfEndable(key: string, reason: EndReason, since?: string): Promise<BegunEnd> {
    return this.#checkEndability(
      key,
      (endability) =>
        endability === 'endable'
          ? { endability, ended: this.#sessions.end(key, reason) }
          : { endability },
      since,
    );
  }

  /** The keys whose session the cap may end, its operations' keys left out, idle longest first. */
  async #endableByIdleness(keys: readonly string[]): Promise<string[]> {
    const endable: Session[] = [];
    for (const key of keys) {
      if (this.#queue.isBusy(key)) continue;
      if ((await this.#checkEndability(key, (each) => each)) !== 'endable') continue;
      const session = this.#sessions.session(key);
      if (session !== undefined) endable.push(session);
    }
    endable.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
    return endable.map((session) => session.key);
  }

  /**
   * Tells whether the key's session may be ended, by the cap or for
   * idleness, and hands it to `act` in the same step as the session is
   * read: the state is read once the terminals are counted, with nothing
   * run between that read and `act`, so that a session found endable is
   * still so as `act` begins its end. With `since`, a session in another
   * `idle` than the one begun then is `not-idle`.
   */
  async #checkEndability<T>(
    key: string,
    act: (endability: Endability) => T,
    since?: string,
  ): Promise<T> {
    // A session that is not endable as it stands needs no count of its terminals.
    const before = endabilityOf(this.#sessions.session(key), 0, since);
    if (before !== 'endable') return act(before);
    // A count the host cannot give is a terminal that may be attached.
    const attached = await this.#sessions.terminalsAttached(key).catch(() => 1);
    return act(endabilityOf(this.#sessions.session(key), attached, since));
  }

  /**
   * Records a launch: the conversation it works in, the earlier ones, its
   * folder and settings, the history. Every conversation the key's
   * sessions worked in is its current one or an earlier one, in the order
   * they were left: the recorded one, the one the session it replaced
   * moved to, the one launched, when the agent left it before the launch
   * settled.
   */
  async #record(plan: Plan, folder: JobFolder, admitted: Admitted): Promise<void> {
    const { take, conversationId } = admitted;
    const before = this.#records.get(plan.key);
    const current = this.#sessions.conversationOf(plan.key) ?? conversationId;
    const earlier = [...(before?.earlierConversations ?? [])];
    for (const left of [before?.conversationId, admitted.before, conversationId]) {
      if (left !== undefined && left !== current && !earlier.includes(left)) earlier.push(left);
    }
    const history = [...(before?.history ?? [])];
    if (plan.history !== undefined) history.push(historyEntryOf(plan.history, take, current));
    await this.#write({
      key: plan.key,
      conversationId: current,
      earlierConversations: earlier,
      history,
      directory: folder.relative,
      launchSettings: this.#settingsOf(plan.run),
    });
    this.#loaded.delete(plan.key);
    this.#notify();
  }

  /**
   * Records a run typed into the key's live session, in the conversation
   * the agent works in: the key's operations run one at a time, so the
   * record read before the typing is still the key's.
   */
  async #recordSent(record: UnitRecord, operation: Operation): Promise<void> {
    const conversationId = this.#sessions.conversationOf(record.key) ?? record.conversationId;
    await this.#write({
      ...record,
      history: [...record.history, { ...operation, action: 'sent', conversationId }],
    });
    this.#notify();
  }

  /**
   * Records the agent's move to another conversation: the one it left is
   * an earlier one. A move told while an operation of the key was under
   * way is recorded after it, and only from the conversation the record
   * holds: a launch already recorded the conversation of the session that
   * replaced the one that moved.
   */
  async #moved(key: string, conversationId: string, left: string): Promise<void> {
    const record = this.#records.get(key);
    if (record?.conversationId !== left) return;
    await this.#write({
      ...record,
      conversationId,
      earlierConversations: [...record.earlierConversations, record.conversationId],
    });
    this.#notify();
  }

  #settingsOf(run: JobRun): DriverSettings {
    return this.#options.driver.launchSettings(run.part);
  }

  /** The key's session when it lives (or is being launched or ended); `undefined` when ended or none. */
  #liveSession(key: string): Session | undefined {
    const session = this.#sessions.session(key);
    return session?.state === 'ended' ? undefined : session;
  }

  /** A recorded key's session: this process's, else the one listed `ended` at load. */
  #sessionOf(record: UnitRecord): Session {
    return (
      this.#sessions.session(record.key) ??
      this.#loaded.get(record.key) ?? {
        key: record.key,
        state: 'ended',
        since: now(),
        canResume: false,
        reason: 'lost',
      }
    );
  }

  #notify(): void {
    this.#followers.tell(() => this.list());
  }
}

/** Whether a record names the conversation: its current one, or an earlier one. */
function namesConversation(record: UnitRecord, conversationId: string): boolean {
  return (
    record.conversationId === conversationId || record.earlierConversations.includes(conversationId)
  );
}

/**
 * Whether a session may be ended by the cap or for idleness: `endable` when
 * `idle` with no background task and no terminal attached, `held` when
 * `idle` with one of them, `not-idle` otherwise.
 */
type Endability = 'endable' | 'held' | 'not-idle';

/** An end the cap or the idle timeout began, unawaited, giving the tasks it stopped; or why none was. */
type BegunEnd =
  | { readonly endability: 'endable'; readonly ended: Promise<readonly BackgroundTask[]> }
  | { readonly endability: Exclude<Endability, 'endable'> };

/** With `since`, a session in another `idle` than the one begun then counts as `not-idle`. */
function endabilityOf(session: Session | undefined, attached: number, since?: string): Endability {
  if (session?.state !== 'idle' || (since !== undefined && session.since !== since)) {
    return 'not-idle';
  }
  return session.backgroundTasks === undefined && attached === 0 ? 'endable' : 'held';
}

function closedRefusal(key: string): SessionsClosedError {
  return new SessionsClosedError(key);
}

/**
 * The arguments of a run as the key's history keeps them, copied at the
 * call: what the caller changes in its object afterwards is not the run's.
 * The copy keeps what a record keeps.
 *
 * @throws `TypeError` for arguments no record can keep (a `BigInt`, a
 * cycle), before anything is launched.
 */
function asRecorded(args: unknown): unknown {
  const text = JSON.stringify(args);
  return text === undefined ? undefined : JSON.parse(text);
}

/** What the key's history keeps of an operation that launched its session. */
function historyEntryOf(operation: Operation, take: Take, conversationId: string): HistoryEntry {
  return {
    ...operation,
    action: take.kind === 'new' ? 'started' : 'resumed',
    ...(take.reason === undefined ? {} : { reason: take.reason }),
    conversationId,
  };
}

/** A plan whose operation the key's history does not keep. */
function withoutOperation({ history: _kept, ...plan }: Plan): Plan {
  return plan;
}

/** A run's result from what its launch did. */
function startedOrResumed(launched: Launched): RunResult {
  const { take, state } = launched;
  if (take.kind === 'resume') {
    const reason = take.reason === undefined ? {} : { reason: take.reason };
    return { action: 'resumed', ...reason, state, ...stoppedTasksOf(launched) };
  }
  const reason = take.reason === undefined ? {} : { reason: take.reason };
  return { action: 'started', ...reason, state, ...stoppedTasksOf(launched) };
}

/** The tasks an end stopped, as a result gives them: absent when none ran. */
function stoppedTasksOf({ stoppedTasks }: Pick<Launched, 'stoppedTasks'>): {
  stoppedTasks?: readonly BackgroundTask[];
} {
  return stoppedTasks.length === 0 ? {} : { stoppedTasks };
}

/** A session with what its unit of work's record shows the app. */
function withRecord(
  session: Session,
  { conversationId, earlierConversations, history }: UnitRecord,
): Session {
  return { ...session, record: { conversationId, earlierConversations, history } };
}

function now(): string {
  return new Date().toISOString();
}
