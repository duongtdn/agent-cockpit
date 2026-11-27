/**
 * The units of work: what a run, a send and an open do in each state of a
 * key's session, on top of the sessions core — the conversation resumed
 * or started anew, a live session ended first, a prompt typed, the cap on
 * live sessions — and the records that keep each key's conversations,
 * history, folder and launch settings.
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
  HistoryEntry,
  OpenOptions,
  OpenResult,
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
import type { JobRun, JobRuns } from './job-runs.js';
import { KeyQueue } from './key-queue.js';
import { type Sessions, SessionsClosedError, wrongState } from './sessions.js';

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
   * The most sessions live at once; no cap when left out. At the cap, a
   * start ends the `idle` session idle longest that has no background
   * task, no terminal attached and no operation under way on its key,
   * else fails `session-cap-reached`. A session it is ending takes no send
   * or run until it is gone.
   */
  readonly maxSessions?: number;
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
   * started: the run settles once the agent took it. A run that fails with
   * its session live is not kept in the key's history.
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
   * launch throws.
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
   * Lists the units of work: each recorded key's session with its record,
   * `ended` when no session of this process lives, in the order the keys
   * were first recorded; then any session not recorded yet.
   *
   * @returns The sessions.
   */
  list(): Session[];
  /**
   * Follows the units of work: the listener gets the list now, then again
   * at every change of a session or a record.
   *
   * @param listener - Called with the list.
   * @returns A function that stops the following.
   */
  follow(listener: (sessions: readonly Session[]) => void): () => void;
  /**
   * Closes the units of work: every operation that has not begun, waiting
   * for its key's turn or asked from now on, is rejected at once with
   * `SessionsClosedError`, and does nothing; the sessions core is no
   * longer followed, and no follower is told anything more.
   */
  close(): void;
}

/**
 * Opens the units of work: each key recorded with no session in this
 * process is listed `ended`, the driver asked whether it still keeps its
 * conversation.
 *
 * @param options - See {@link UnitsOfWorkOptions}.
 * @returns The units of work.
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
}

/** A run or an open, as the key's history keeps it before it is known what it did. */
type Operation = Pick<HistoryEntry, 'operation' | 'jobId' | 'args' | 'at'>;

/** A launch admitted: the conversation it took up, and the tasks the session it replaced stopped. */
interface Admitted {
  readonly take: Take;
  readonly conversationId: string;
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
  readonly #queue = new KeyQueue();
  readonly #admissions = new KeyQueue();
  readonly #followers = new Set<(sessions: readonly Session[]) => void>();
  readonly #stops: (() => void)[];

  constructor(options: UnitsOfWorkOptions, loaded: Map<string, EndedSession>) {
    this.#options = options;
    this.#sessions = options.sessions;
    this.#records = options.records;
    this.#jobs = options.jobs;
    this.#loaded = loaded;
    this.#stops = [
      this.#sessions.follow(() => this.#notify()),
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
    return this.#queue.run(reading.key, async () =>
      this.#run(await reading.checked(), options.fresh === true, at),
    );
  }

  async send(key: string, prompt: string): Promise<SendResult> {
    refuseUnfitPrompt(prompt);
    return this.#queue.run(key, () => this.#send(key, prompt));
  }

  async open(key: string, options: OpenOptions = {}): Promise<OpenResult> {
    const at = now();
    return this.#queue.run(key, () => this.#open(key, options.fresh === true, at));
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
    const follower = (sessions: readonly Session[]) => listener(sessions);
    this.#followers.add(follower);
    follower(this.list());
    return () => void this.#followers.delete(follower);
  }

  close(): void {
    const closed = (key: string) => new SessionsClosedError(key);
    this.#queue.close(closed);
    this.#admissions.close(closed);
    for (const stop of this.#stops.splice(0)) stop();
    this.#followers.clear();
  }

  async #run(run: JobRun, fresh: boolean, at: string): Promise<RunResult> {
    const { key } = run;
    const record = this.#records.get(key);
    const session = this.#liveSession(key);
    const history: Operation = { operation: 'run', jobId: run.jobId, args: run.args, at };
    const launch = (take: Take, endFirst?: EndReason) =>
      this.#launch({
        key,
        run,
        prompt: run.prompt,
        take,
        ...(endFirst === undefined ? {} : { endFirst }),
        history,
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

  async #send(key: string, prompt: string): Promise<SendResult> {
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
    const { take, state } = await this.#launch({ key, run, prompt, take: { kind: 'resume' } });
    return take.kind === 'resume'
      ? { action: 'resumed', state }
      : { action: 'started', reason: 'conversation-gone', state };
  }

  async #open(key: string, fresh: boolean, at: string): Promise<OpenResult> {
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
   * launch for the record.
   */
  async #launch(plan: Plan): Promise<Launched> {
    const folder = await this.#jobs.makeFolder(plan.run.folder);
    let admitted = await this.#admit(plan, folder);
    let session = await this.#launched(plan, folder, admitted);
    if (admitted.take.kind === 'resume' && session.state === 'ended' && !session.canResume) {
      const { stoppedTasks } = admitted;
      const anew: Plan = {
        ...plan,
        take: { kind: 'new', reason: 'conversation-gone' },
      };
      admitted = { ...(await this.#admit(anew, folder)), stoppedTasks };
      session = await this.#launched(anew, folder, admitted);
    }
    await this.#record(plan, folder, admitted);
    return { take: admitted.take, state: session.state, stoppedTasks: admitted.stoppedTasks };
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
   * key taken, before the next admission counts the live sessions.
   */
  async #admit(plan: Plan, folder: JobFolder): Promise<Admitted> {
    return this.#admissions.run(ADMISSION, async () => {
      const stoppedTasks =
        plan.endFirst === undefined ? [] : await this.#sessions.end(plan.key, plan.endFirst);
      const { take, conversationId } = await this.#takeUp(plan, folder);
      await this.#makeRoom(plan.key);
      const launching = this.#sessions.launch({
        key: plan.key,
        directory: folder.path,
        conversationId,
        ...(take.kind === 'resume' ? { resume: true } : {}),
        ...(plan.prompt === undefined ? {} : { prompt: plan.prompt }),
        ...(plan.run.part === undefined ? {} : { part: plan.run.part }),
      });
      launching.catch(() => {});
      return { take, conversationId, stoppedTasks, launching };
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
      const idlest = await this.#idlest(live);
      if (idlest === undefined) {
        throw new CockpitError(
          'session-cap-reached',
          `${live.length} sessions live, the most the app allows, and none can be ended to make room.`,
          { cap, live },
        );
      }
      await this.#sessions.end(idlest, 'session-cap');
    }
  }

  async #idlest(keys: readonly string[]): Promise<string | undefined> {
    const endable: Session[] = [];
    for (const key of keys) {
      const session = this.#sessions.session(key);
      if (session?.state !== 'idle' || session.backgroundTasks !== undefined) continue;
      if (this.#queue.isBusy(key)) continue;
      // A count the host cannot give is a terminal that may be attached.
      const attached = await this.#sessions.terminalsAttached(key).catch(() => 1);
      if (attached === 0) endable.push(session);
    }
    endable.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
    return endable[0]?.key;
  }

  /** Records a launch: the conversation it works in, the earlier ones, its folder and settings, the history. */
  async #record(plan: Plan, folder: JobFolder, { take, conversationId }: Admitted): Promise<void> {
    const before = this.#records.get(plan.key);
    const current = this.#sessions.conversationOf(plan.key) ?? conversationId;
    const earlier = [...(before?.earlierConversations ?? [])];
    // A new conversation, or one the agent moved to before a restart resumed it.
    if (before !== undefined && before.conversationId !== conversationId) {
      earlier.push(before.conversationId);
    }
    // The agent moved to another conversation (a `/clear`) before the launch settled.
    if (current !== conversationId) earlier.push(conversationId);
    const history = [...(before?.history ?? [])];
    if (plan.history !== undefined) {
      history.push({
        ...plan.history,
        action: take.kind === 'new' ? 'started' : 'resumed',
        ...(take.reason === undefined ? {} : { reason: take.reason }),
        conversationId: current,
      });
    }
    await this.#records.put({
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
    await this.#records.put({
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
    await this.#records.put({
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
    if (this.#followers.size === 0) return;
    const sessions = this.list();
    for (const follower of this.#followers) follower(sessions);
  }
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

function stoppedTasksOf({ stoppedTasks }: Launched): { stoppedTasks?: readonly BackgroundTask[] } {
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
