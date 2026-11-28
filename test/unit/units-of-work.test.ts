import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverPart } from '../../src/server/driver.ts';
import { MAX_PROMPT_LENGTH } from '../../src/server/prompt-length.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import type { JobRun, JobRuns } from '../../src/server/sessions/job-runs.ts';
import {
  createSessions,
  LIVENESS_INTERVAL_MS,
  SCREEN_INTERVAL_MS,
  type Sessions,
  SessionsClosedError,
} from '../../src/server/sessions/sessions.ts';
import { openUnitsOfWork, type UnitsOfWork } from '../../src/server/sessions/units-of-work.ts';
import type { UnitRecord } from '../../src/server/state/records.ts';
import { createTerminalHolds } from '../../src/server/terminal-hold.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import type { RunResult, Session } from '../../src/shared/session.ts';
import {
  CONVERSATION_PATH,
  createFakeHost,
  createMemoryRecords,
  createRecordingHookAccess,
  createStubDriver,
  type FakeHost,
  type MemoryRecords,
  PROMPT_PATH,
  type StubDriver,
  stubFolders,
  stubScreen,
} from '../support/sessions-doubles.ts';

const T0 = new Date('2026-11-27T10:00:00.000Z');
const APP = '/apps/demo';
const KEY = 'explain-a';
const PLAN: DriverPart = { permissionMode: 'plan' };
const UUID = /^[0-9a-f-]{36}$/;

/** The app's jobs, as a stub reads them: each from its arguments. */
const JOBS: Readonly<Record<string, (args: { file: string }) => Omit<JobRun, 'jobId'>>> = {
  explain: ({ file }) => ({ key: `explain-${file}`, prompt: `Explain ${file}.`, ...rest(file) }),
  review: ({ file }) => ({
    key: `explain-${file}`,
    prompt: `Review ${file}.`,
    part: PLAN,
    ...rest(file),
  }),
  type: ({ file }) => ({ key: `explain-${file}`, ...rest(file) }),
  redraft: ({ file }) => ({
    key: `explain-${file}`,
    prompt: `Redraft ${file}.`,
    ...rest(file),
    fresh: true,
  }),
  books: ({ file }) => ({
    key: `explain-${file}`,
    prompt: `Explain ${file}.`,
    ...rest(file),
    folder: { path: `${APP}/books`, relative: 'books' },
  }),
  'plan-typing': ({ file }) => ({ key: `explain-${file}`, part: PLAN, ...rest(file) }),
  long: ({ file }) => ({ key: `explain-${file}`, prompt: longPrompt, ...rest(file) }),
  blank: ({ file }) => ({ key: `explain-${file}`, prompt: ' \n ', ...rest(file) }),
};

/** The prompt of the `long` job. */
let longPrompt = '';

function rest(file: string): Pick<JobRun, 'args' | 'folder' | 'fresh'> {
  return { args: { file }, folder: { path: APP, relative: '.' }, fresh: false };
}

let host: FakeHost;
let driver: StubDriver;
let records: MemoryRecords;
let sessions: Sessions;
let units: UnitsOfWork;
/** The jobs read, `<jobId> <file>`, in order. */
let reads: string[];
/** What reading a job throws from now on, by its id. */
let refusals: Map<string, unknown>;
/** What every check of a run's job waits for, when set. */
let checking: Promise<void> | undefined;
/** The folders made, by their relative path. */
let made: string[];
/** Every signal sent, `<key> <signal>`; an agent exits on one when `exitOnSignal`. */
let signals: string[];
let exitOnSignal: boolean;

const jobs: JobRuns = {
  read(jobId, args) {
    const job = JOBS[jobId];
    if (job === undefined) throw new CockpitError('unknown-job', `No ${jobId}.`, { jobId });
    // The arguments as given, as the cockpit's reader keeps them.
    const run = { jobId, ...job(args as { file: string }), args };
    return {
      key: run.key,
      ...(run.prompt === undefined ? {} : { prompt: run.prompt }),
      async checked() {
        await checking;
        const refusal = refusals.get(jobId);
        if (refusal !== undefined) throw refusal;
        reads.push(`${jobId} ${(args as { file: string }).file}`);
        return run;
      },
    };
  },
  async makeFolder(folder) {
    made.push(folder.relative);
    return folder;
  },
  async recordedFolder(relative) {
    return { path: relative === '.' ? APP : `${APP}/${relative}`, relative };
  },
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  host = createFakeHost();
  driver = createStubDriver();
  driver.launchSettings = (part) => ({ part: (part ?? null) as never });
  reads = [];
  refusals = new Map();
  checking = undefined;
  made = [];
  signals = [];
  exitOnSignal = true;
  sessions = createSessions({
    host,
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
    signal(pid, signal) {
      const key = sessions.liveKeys().find((each) => host.pidOf(each) === pid);
      signals.push(`${key} ${signal}`);
      if (exitOnSignal && key !== undefined) host.exit(key);
    },
  });
});

afterEach(() => {
  units?.close();
  sessions.close();
  vi.useRealTimers();
});

async function open(
  options: { records?: readonly UnitRecord[]; maxSessions?: number } = {},
): Promise<UnitsOfWork> {
  records = createMemoryRecords(options.records);
  units = await openUnitsOfWork({
    sessions,
    records,
    jobs,
    driver,
    environment: () => ({ PATH: '/usr/bin' }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
  });
  return units;
}

function hook(path: string, key = KEY): void {
  sessions.receive({ key, path, body: {} });
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Lets the liveness watch see a session gone, a graceful end's among them. */
const listHost = () => vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

/** Keeps a pending outcome from failing the test before it looks. */
function pending<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** Runs a job to its start, the agent taking the prompt: `busy`. */
async function started(jobId = 'explain', file = 'a'): Promise<void> {
  const ran = pending(units.run(jobId, { file }));
  await settle();
  hook('/start-and-take', `explain-${file}`);
  await ran;
}

/** Ends the key's turn: `idle`, its input box on screen. */
function idle(key = KEY): void {
  hook('/turn-ended', key);
  host.show(key, stubScreen('input-box'));
}

/** Makes the key's agent exit by itself, and the core see it. */
async function exits(key = KEY): Promise<void> {
  host.exit(key);
  await listHost();
}

function sessionOf(key = KEY): Session | undefined {
  return units.list().find((session) => session.key === key);
}

function recordOf(key = KEY): UnitRecord | undefined {
  return records.get(key);
}

describe('a run on a key with no record', () => {
  beforeEach(() => open());

  it('starts the agent in a new conversation, the prompt passed at launch, in the folder made', async () => {
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(driver.launches).toMatchObject([
      {
        key: KEY,
        directory: APP,
        prompt: 'Explain a.',
        conversationId: expect.stringMatching(UUID),
      },
    ]);
    expect(driver.launches[0]).not.toHaveProperty('resume');
    expect(made).toEqual(['.']);
  });

  it('records the key: its conversation, folder, launch settings and the run in its history', async () => {
    await started();

    const conversationId = driver.launches[0]?.conversationId;
    expect(recordOf()).toEqual({
      key: KEY,
      conversationId,
      earlierConversations: [],
      history: [
        {
          operation: 'run',
          jobId: 'explain',
          args: { file: 'a' },
          at: T0.toISOString(),
          action: 'started',
          conversationId,
        },
      ],
      directory: '.',
      launchSettings: { part: null },
    });
  });

  it('keeps the arguments in the history as they were at the call: a change the caller makes after is not recorded', async () => {
    const args = { file: 'a' };
    const ran = pending(units.run('explain', args));
    args.file = 'changed';
    await settle();
    hook('/start-and-take');
    await ran;

    expect(recordOf()?.history).toMatchObject([{ args: { file: 'a' } }]);
  });

  it('lists the session with its record', async () => {
    await started();

    expect(sessionOf()).toMatchObject({
      key: KEY,
      state: 'busy',
      record: { conversationId: driver.launches[0]?.conversationId, earlierConversations: [] },
    });
  });

  it('starts the same way with `fresh`', async () => {
    const ran = pending(units.run('explain', { file: 'a' }, { fresh: true }));
    await settle();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
  });

  it('starts a job with no prompt with none, and resolves at `idle`', async () => {
    const ran = pending(units.run('type', { file: 'a' }));
    await settle();
    hook('/ready');

    await expect(ran).resolves.toEqual({ action: 'started', state: 'idle' });
    expect(driver.launches[0]).not.toHaveProperty('prompt');
  });

  it(`refuses a prompt over ${MAX_PROMPT_LENGTH} characters, \`prompt-too-long\`, launching nothing`, async () => {
    longPrompt = 'x'.repeat(MAX_PROMPT_LENGTH + 1);
    const long = units.run('long', { file: 'a' });

    await expect(long).rejects.toMatchObject({
      code: 'prompt-too-long',
      length: MAX_PROMPT_LENGTH + 1,
      max: MAX_PROMPT_LENGTH,
    });
    expect(driver.launches).toEqual([]);
  });

  it('refuses a job that gives a blank prompt at once, `invalid-arguments`, launching nothing', async () => {
    await expect(units.run('blank', { file: 'a' })).rejects.toMatchObject({
      code: 'invalid-arguments',
      issues: [{ path: ['prompt'] }],
    });
    expect(driver.launches).toEqual([]);
  });

  it('refuses what reading the job refuses, launching nothing', async () => {
    const refusal = new CockpitError('not-a-choice', 'No.', { field: 'file', value: 'z' });
    refusals.set('explain', refusal);

    await expect(units.run('explain', { file: 'z' })).rejects.toBe(refusal);
    expect(driver.launches).toEqual([]);
  });

  it('types a first prompt too long for the command line once the agent is ready: the same result', async () => {
    driver.promptFitsLaunch = () => false;
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await settle();
    hook(`${PROMPT_PATH}Explain a.`);

    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(driver.launches[0]).not.toHaveProperty('prompt');
    expect(recordOf()?.history).toHaveLength(1);
  });

  it('records the session whose typed first prompt was not taken, `idle` in its conversation, but not the run', async () => {
    driver.promptFitsLaunch = () => false;
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(ran).rejects.toMatchObject({ code: 'prompt-not-taken', state: 'idle' });
    expect(recordOf()).toMatchObject({
      conversationId: driver.launches[0]?.conversationId,
      history: [],
    });
  });

  it('settles a run whose typed first prompt waits behind a start-up dialog only once the agent took it', async () => {
    driver.promptFitsLaunch = () => false;
    let result: unknown;
    const ran = pending(units.run('explain', { file: 'a' }));
    void ran.then((settled) => {
      result = settled;
    });
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    expect(sessionOf()?.state).toBe('waiting');
    expect(result).toBeUndefined();

    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await settle();
    hook(`${PROMPT_PATH}Explain a.`);

    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(recordOf()?.history).toMatchObject([{ action: 'started' }]);
  });

  /** Runs the `long` job, typed after the start, to a start-up dialog: the run parked. */
  async function parkedBehindADialog(): Promise<{ ran: Promise<RunResult> }> {
    driver.promptFitsLaunch = () => false;
    longPrompt = 'A long prompt.';
    const ran = pending(units.run('long', { file: 'a' }));
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    return { ran };
  }

  it('records the session of a run parked behind a start-up dialog at once, its run once the agent took the prompt', async () => {
    const { ran } = await parkedBehindADialog();

    expect(recordOf()).toMatchObject({
      conversationId: driver.launches[0]?.conversationId,
      history: [],
    });
    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await settle();
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(recordOf()?.history).toMatchObject([
      { operation: 'run', jobId: 'long', action: 'started' },
    ]);
  });

  it('frees the key while its run is parked behind a start-up dialog: a run, a send refused `wrong-state` with the dialog, an open has nothing to open', async () => {
    const { ran } = await parkedBehindADialog();
    const pendingDialog = [{ kind: 'terminal', dialog: 'trust-folder' }];

    await expect(units.run('explain', { file: 'a' })).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'waiting',
      pending: pendingDialog,
    });
    await expect(units.send(KEY, 'Go on.')).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'waiting',
      pending: pendingDialog,
    });
    await expect(units.open(KEY)).resolves.toEqual({ action: 'nothing-to-open', state: 'waiting' });
    await expect(units.run('type', { file: 'a' })).resolves.toEqual({
      action: 'nothing-to-send',
      state: 'waiting',
    });
    expect(driver.launches).toHaveLength(1);

    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await settle();
    hook(`${PROMPT_PATH}A long prompt.`);
    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
  });

  it('ends the session of a parked run on a `fresh` run: the parked run settles `ended`, its history before the fresh one', async () => {
    const { ran } = await parkedBehindADialog();
    const parked = driver.launches[0]?.conversationId;
    vi.setSystemTime(T0.getTime() + 60_000);
    driver.promptFitsLaunch = () => true;
    host.show(KEY, stubScreen('input-box'));

    const fresh = pending(units.run('explain', { file: 'a' }, { fresh: true }));
    await settle();
    await listHost();
    hook('/start-and-take');
    await expect(ran).resolves.toEqual({ action: 'started', state: 'ended' });
    await expect(fresh).resolves.toEqual({
      action: 'started',
      reason: 'fresh-on-request',
      state: 'busy',
    });
    await settle();

    const renewed = driver.launches[1]?.conversationId;
    expect(signals).toEqual([`${KEY} SIGTERM`]);
    expect(recordOf()).toMatchObject({
      conversationId: renewed,
      earlierConversations: [parked],
      history: [
        { jobId: 'long', action: 'started', conversationId: parked },
        {
          jobId: 'explain',
          action: 'started',
          reason: 'fresh-on-request',
          conversationId: renewed,
        },
      ],
    });
  });

  it('fails a parked run whose prompt was not taken once the dialog was answered: its session recorded, not the run', async () => {
    const { ran } = await parkedBehindADialog();

    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(ran).rejects.toMatchObject({ code: 'prompt-not-taken', state: 'idle' });
    expect(recordOf()).toMatchObject({
      conversationId: driver.launches[0]?.conversationId,
      history: [],
    });
  });

  describe('parked behind a dialog shown once the agent was ready', () => {
    /** Runs the `long` job until the agent is ready, then shows a dialog in place of its box: the run parked. */
    async function parkedAfterReady(): Promise<{
      ran: Promise<RunResult>;
      parked: string | undefined;
    }> {
      driver.promptFitsLaunch = () => false;
      longPrompt = 'A long prompt.';
      const ran = pending(units.run('long', { file: 'a' }));
      await settle();
      hook('/ready');
      host.show(KEY, stubScreen('dialog'));
      await vi.advanceTimersByTimeAsync(300);
      expect(sessionOf()?.state).toBe('waiting');
      return { ran, parked: driver.launches.at(-1)?.conversationId };
    }

    it('settles the parked run `ended` on a `fresh` run, its history before the fresh one', async () => {
      const { ran, parked } = await parkedAfterReady();
      vi.setSystemTime(T0.getTime() + 60_000);
      driver.promptFitsLaunch = () => true;

      const fresh = pending(units.run('explain', { file: 'a' }, { fresh: true }));
      await settle();
      // The new session's screen: the old one's dialog went with it.
      host.show(KEY, '');
      await listHost();
      hook('/start-and-take');

      await expect(ran).resolves.toEqual({ action: 'started', state: 'ended' });
      await expect(fresh).resolves.toMatchObject({ reason: 'fresh-on-request', state: 'busy' });
      await settle();
      expect(recordOf()?.history).toMatchObject([
        { jobId: 'long', action: 'started', conversationId: parked },
        { jobId: 'explain', reason: 'fresh-on-request' },
      ]);
    });

    it('settles the parked run of a resumed unit `ended` on an open with `fresh`, its history before the open', async () => {
      // An open takes up the key's last run: the unit ran once before.
      await started();
      idle();
      await exits();
      host.show(KEY, '');
      const { ran } = await parkedAfterReady();
      const parked = driver.launches[1]?.conversationId;
      vi.setSystemTime(T0.getTime() + 60_000);

      const opened = pending(units.open(KEY, { fresh: true }));
      await settle();
      // The new session's screen: the old one's dialog went with it.
      host.show(KEY, '');
      await listHost();
      hook('/ready');

      await expect(ran).resolves.toEqual({ action: 'resumed', state: 'ended' });
      await expect(opened).resolves.toMatchObject({ reason: 'fresh-on-request', state: 'idle' });
      await settle();
      expect(recordOf()?.history).toMatchObject([
        { jobId: 'explain', action: 'started' },
        { jobId: 'long', action: 'resumed', conversationId: parked },
        { operation: 'open', reason: 'fresh-on-request' },
      ]);
    });

    it('settles the parked run `ended` when the agent exits, its history written', async () => {
      const { ran, parked } = await parkedAfterReady();

      await exits();

      await expect(ran).resolves.toEqual({ action: 'started', state: 'ended' });
      await settle();
      expect(recordOf()?.history).toMatchObject([
        { jobId: 'long', action: 'started', conversationId: parked },
      ]);
    });
  });
});

describe('a run on a live session', () => {
  beforeEach(() => open());

  it('is refused on `busy` with `wrong-state`', async () => {
    await started();

    await expect(units.run('explain', { file: 'a' })).rejects.toMatchObject({
      code: 'wrong-state',
      key: KEY,
      state: 'busy',
    });
  });

  it('is refused on `waiting` with `wrong-state` and what it waits for', async () => {
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    await expect(ran).resolves.toEqual({ action: 'started', state: 'waiting' });

    await expect(units.run('explain', { file: 'a' })).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'waiting',
      pending: [{ kind: 'terminal', dialog: 'trust-folder' }],
    });
  });

  it('is refused on `starting` with `wrong-state`, `fresh` too', async () => {
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    await ran;
    hook('/ready');

    await expect(units.run('explain', { file: 'a' })).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'starting',
    });
    await expect(units.run('explain', { file: 'a' }, { fresh: true })).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'starting',
    });
  });

  it('types the prompt into an `idle` session launched with the same settings: `sent`, kept in the history', async () => {
    await started();
    idle();
    const conversationId = driver.launches[0]?.conversationId;
    const before = recordOf();
    await vi.advanceTimersByTimeAsync(60_000);
    const at = new Date().toISOString();

    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    hook(`${PROMPT_PATH}Explain a.`);

    await expect(ran).resolves.toEqual({ action: 'sent', state: 'busy' });
    expect(host.writes).toContain(`${KEY} text:Explain a.`);
    expect(driver.launches).toHaveLength(1);
    expect(recordOf()).toEqual({
      ...before,
      history: [
        ...(before?.history ?? []),
        {
          operation: 'run',
          jobId: 'explain',
          args: { file: 'a' },
          at,
          action: 'sent',
          conversationId,
        },
      ],
    });
    expect(units.list()[0]?.record?.history).toHaveLength(2);
  });

  it('keeps nothing in the history of a run typed into an `idle` session that the agent did not take', async () => {
    await started();
    idle();
    const before = recordOf();

    const ran = pending(units.run('explain', { file: 'a' }));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(ran).rejects.toMatchObject({ code: 'prompt-not-taken', state: 'idle' });
    expect(recordOf()).toEqual(before);
  });

  it('restarts an `idle` session launched with other settings, resuming its conversation with the run’s', async () => {
    await started();
    idle();
    const conversationId = driver.launches[0]?.conversationId;

    const ran = pending(units.run('review', { file: 'a' }));
    await settle();
    expect(signals).toEqual([`${KEY} SIGTERM`]);
    await listHost();
    expect(sessions.session(KEY)).toMatchObject({ state: 'starting' });
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({
      action: 'resumed',
      reason: 'settings-changed',
      state: 'busy',
    });
    expect(driver.launches[1]).toMatchObject({
      conversationId,
      resume: true,
      prompt: 'Review a.',
      part: PLAN,
    });
    expect(recordOf()).toMatchObject({
      conversationId,
      launchSettings: { part: PLAN },
      history: [
        { action: 'started' },
        { jobId: 'review', action: 'resumed', reason: 'settings-changed', conversationId },
      ],
    });
  });

  it('lists the background tasks the restart stopped', async () => {
    await started();
    hook('/turn-ended-with-a-task');
    host.show(KEY, stubScreen('input-box'));

    const ran = pending(units.run('review', { file: 'a' }));
    await listHost();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({
      action: 'resumed',
      reason: 'settings-changed',
      state: 'busy',
      stoppedTasks: [{ id: 'a1', type: 'general-purpose' }],
    });
  });

  it('sees the session that a restart ended as `ended`, `restarted`, in its followers', async () => {
    await started();
    idle();
    const states: string[] = [];
    units.follow((list) => {
      const session = list[0];
      const seen = session?.state === 'ended' ? `ended ${session.reason}` : session?.state;
      if (seen !== undefined && states.at(-1) !== seen) states.push(seen);
    });

    const ran = pending(units.run('review', { file: 'a' }));
    await listHost();
    hook('/start-and-take');
    await ran;

    expect(states).toEqual(['idle', 'ended restarted', 'starting', 'busy']);
  });

  it('kills a session the restart’s signal did not end, once the driver’s bound passed', async () => {
    await started();
    idle();
    exitOnSignal = false;

    const ran = pending(units.run('review', { file: 'a' }));
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    hook('/start-and-take');

    await expect(ran).resolves.toMatchObject({ action: 'resumed' });
    expect(host.kills).toEqual([KEY]);
  });

  it('refuses a run whose job gives another folder than the recorded one: `folder-changed`', async () => {
    await started();
    idle();

    await expect(units.run('books', { file: 'a' })).rejects.toMatchObject({
      code: 'folder-changed',
      recorded: '.',
      computed: 'books',
    });
    expect(signals).toEqual([]);
  });

  it('has nothing to send for a job with no prompt, whatever the live state', async () => {
    await started();

    await expect(units.run('type', { file: 'a' })).resolves.toEqual({
      action: 'nothing-to-send',
      state: 'busy',
    });
    idle();
    const sameSettings = units.run('type', { file: 'a' });
    await expect(sameSettings).resolves.toEqual({ action: 'nothing-to-send', state: 'idle' });
  });

  it('restarts for a job with no prompt whose settings differ from the `idle` session’s', async () => {
    await started();
    idle();

    const ran = pending(units.run('plan-typing', { file: 'a' }));
    await listHost();
    hook('/ready');

    await expect(ran).resolves.toEqual({
      action: 'resumed',
      reason: 'settings-changed',
      state: 'idle',
    });
  });
});

describe('a run with `fresh` on a live session', () => {
  beforeEach(() => open());

  it.each([
    ['idle', () => idle()],
    ['busy', () => {}],
  ])(
    'ends the `%s` session, then starts a new conversation: `fresh-on-request`',
    async (_state, bring) => {
      await started();
      bring();
      const old = driver.launches[0]?.conversationId;

      const ran = pending(units.run('explain', { file: 'a' }, { fresh: true }));
      await listHost();
      hook('/start-and-take');

      await expect(ran).resolves.toEqual({
        action: 'started',
        reason: 'fresh-on-request',
        state: 'busy',
      });
      const fresh = driver.launches[1]?.conversationId;
      expect(fresh).not.toBe(old);
      expect(driver.launches[1]).not.toHaveProperty('resume');
      expect(recordOf()).toMatchObject({ conversationId: fresh, earlierConversations: [old] });
    },
  );

  it('lists the background tasks stopped with the old session', async () => {
    await started();
    hook('/turn-ended-with-a-task');

    const ran = pending(units.run('explain', { file: 'a' }, { fresh: true }));
    await listHost();
    hook('/start-and-take');

    await expect(ran).resolves.toMatchObject({
      action: 'started',
      reason: 'fresh-on-request',
      stoppedTasks: [{ id: 'a1', type: 'general-purpose' }],
    });
  });

  it('records the folder anew: a job that gives another folder is not refused', async () => {
    await started();

    const ran = pending(units.run('books', { file: 'a' }, { fresh: true }));
    await listHost();
    hook('/start-and-take');

    await expect(ran).resolves.toMatchObject({ action: 'started', reason: 'fresh-on-request' });
    expect(recordOf()?.directory).toBe('books');
    expect(driver.launches[1]?.directory).toBe(`${APP}/books`);
  });
});

describe('a run on an `ended` session', () => {
  beforeEach(async () => {
    await open();
    await started();
    idle();
    await exits();
  });

  it('resumes the conversation with the prompt passed at launch: `resumed`', async () => {
    const conversationId = driver.launches[0]?.conversationId;

    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({ action: 'resumed', state: 'busy' });
    expect(driver.launches[1]).toMatchObject({
      conversationId,
      resume: true,
      prompt: 'Explain a.',
    });
    expect(recordOf()?.history).toMatchObject([
      { action: 'started' },
      { action: 'resumed', conversationId },
    ]);
  });

  it('starts a new conversation for a job that asks for it: `fresh`, the old one earlier', async () => {
    const old = driver.launches[0]?.conversationId;

    const ran = pending(units.run('redraft', { file: 'a' }));
    await settle();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({ action: 'started', reason: 'fresh', state: 'busy' });
    expect(driver.launches[1]?.conversationId).not.toBe(old);
    expect(recordOf()?.earlierConversations).toEqual([old]);
    expect(recordOf()?.history.at(-1)).toMatchObject({ action: 'started', reason: 'fresh' });
  });

  it('resumes it for a job with no prompt, which resolves at `idle`: `resumed`', async () => {
    const ran = pending(units.run('type', { file: 'a' }));
    await settle();
    hook('/ready');

    await expect(ran).resolves.toEqual({ action: 'resumed', state: 'idle' });
    expect(driver.launches[1]).toMatchObject({ resume: true });
    expect(driver.launches[1]).not.toHaveProperty('prompt');
  });

  it('starts a new conversation with `fresh`: `fresh-on-request`', async () => {
    const ran = pending(units.run('explain', { file: 'a' }, { fresh: true }));
    await settle();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({
      action: 'started',
      reason: 'fresh-on-request',
      state: 'busy',
    });
  });

  it('starts a new conversation when the agent no longer keeps it: `conversation-gone`', async () => {
    driver.resumable = false;
    const old = driver.launches[0]?.conversationId;

    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({
      action: 'started',
      reason: 'conversation-gone',
      state: 'busy',
    });
    expect(driver.launches[1]).not.toHaveProperty('resume');
    expect(recordOf()).toMatchObject({
      earlierConversations: [old],
      history: [{ action: 'started' }, { action: 'started', reason: 'conversation-gone' }],
    });
  });

  it('starts anew when the resumed agent exits at once with nothing kept: `conversation-gone`', async () => {
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    driver.resumable = false;
    hook('/agent-exit');
    await exits();
    hook('/start-and-take');

    await expect(ran).resolves.toEqual({
      action: 'started',
      reason: 'conversation-gone',
      state: 'busy',
    });
    expect(driver.launches).toHaveLength(3);
    expect(driver.launches[2]).not.toHaveProperty('resume');
    expect(recordOf()).toMatchObject({
      conversationId: driver.launches[2]?.conversationId,
      earlierConversations: [driver.launches[0]?.conversationId],
      history: [{ action: 'started' }, { action: 'started', reason: 'conversation-gone' }],
    });
  });

  it('refuses a job that gives another folder than the recorded one: `folder-changed`', async () => {
    await expect(units.run('books', { file: 'a' })).rejects.toMatchObject({
      code: 'folder-changed',
    });
    expect(driver.launches).toHaveLength(1);
  });
});

describe('a send', () => {
  beforeEach(() => open());

  it('is refused for a key with no record: `unknown-key`', async () => {
    await expect(units.send(KEY, 'Hello')).rejects.toMatchObject({
      code: 'unknown-key',
      key: KEY,
    });
  });

  it(`is refused over ${MAX_PROMPT_LENGTH} characters, before anything: \`prompt-too-long\``, async () => {
    await expect(units.send(KEY, 'x'.repeat(MAX_PROMPT_LENGTH + 1))).rejects.toMatchObject({
      code: 'prompt-too-long',
    });
  });

  it('is refused blank at once, `invalid-arguments`, nothing typed', async () => {
    await started();
    idle();

    await expect(units.send(KEY, '  \n')).rejects.toMatchObject({ code: 'invalid-arguments' });
    expect(host.writes).toEqual([]);
  });

  it('types into an `idle` session: `sent`, the session’s settings kept, nothing recorded', async () => {
    await started('review');
    idle();
    const puts = records.puts;

    const sent = pending(units.send(KEY, 'Hello'));
    await settle();
    hook(`${PROMPT_PATH}Hello`);

    await expect(sent).resolves.toEqual({ action: 'sent', state: 'busy' });
    expect(driver.launches).toHaveLength(1);
    expect(records.puts).toBe(puts);
  });

  it('is refused on `busy` with `wrong-state`', async () => {
    await started();

    await expect(units.send(KEY, 'Hello')).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'busy',
    });
  });

  it('fails `prompt-not-taken` when the agent does not take it', async () => {
    await started();
    idle();

    const sent = pending(units.send(KEY, 'Hello'));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(sent).rejects.toMatchObject({ code: 'prompt-not-taken', state: 'idle' });
  });

  describe('on an `ended` session', () => {
    beforeEach(async () => {
      await started('review');
      idle();
      await exits();
    });

    it('resumes it with the prompt, the last run’s job read again with its recorded arguments: `resumed`', async () => {
      const conversationId = driver.launches[0]?.conversationId;
      reads.length = 0;

      const sent = pending(units.send(KEY, 'Hello'));
      await settle();
      hook('/start-and-take');

      await expect(sent).resolves.toEqual({ action: 'resumed', state: 'busy' });
      expect(reads).toEqual(['review a']);
      expect(driver.launches[1]).toMatchObject({
        conversationId,
        resume: true,
        prompt: 'Hello',
        part: PLAN,
      });
      expect(recordOf()?.history).toHaveLength(1);
    });

    it('starts anew when the agent no longer keeps its conversation: `conversation-gone`', async () => {
      driver.resumable = false;

      const sent = pending(units.send(KEY, 'Hello'));
      await settle();
      hook('/start-and-take');

      await expect(sent).resolves.toEqual({
        action: 'started',
        reason: 'conversation-gone',
        state: 'busy',
      });
      expect(recordOf()?.earlierConversations).toEqual([driver.launches[0]?.conversationId]);
    });

    it('is refused `unknown-job` when the last run’s job is gone', async () => {
      refusals.set('review', new CockpitError('unknown-job', 'Gone.', { jobId: 'review' }));

      await expect(units.send(KEY, 'Hello')).rejects.toMatchObject({
        code: 'unknown-job',
        jobId: 'review',
      });
      expect(driver.launches).toHaveLength(1);
    });

    it('is refused what any run check refuses on the recorded arguments', async () => {
      const refusal = new CockpitError('invalid-options', 'Opened beyond loopback.', {
        issues: [],
      });
      refusals.set('review', refusal);

      await expect(units.send(KEY, 'Hello')).rejects.toBe(refusal);
    });
  });
});

describe('an open', () => {
  beforeEach(() => open());

  it('has nothing to open for a key with no record, `fresh` or not', async () => {
    await expect(units.open(KEY)).resolves.toEqual({ action: 'nothing-to-open' });
    await expect(units.open(KEY, { fresh: true })).resolves.toEqual({ action: 'nothing-to-open' });
  });

  it('has nothing to open on a live session, with its state', async () => {
    await started();

    await expect(units.open(KEY)).resolves.toEqual({ action: 'nothing-to-open', state: 'busy' });
  });

  it('resumes an `ended` session with no prompt, with the last run’s settings: `resumed`, recorded', async () => {
    await started('review');
    idle();
    await exits();
    const conversationId = driver.launches[0]?.conversationId;

    const opened = pending(units.open(KEY));
    await settle();
    hook('/ready');

    await expect(opened).resolves.toEqual({ action: 'resumed', state: 'idle' });
    expect(driver.launches[1]).toMatchObject({ conversationId, resume: true, part: PLAN });
    expect(driver.launches[1]).not.toHaveProperty('prompt');
    expect(recordOf()?.history).toMatchObject([
      { operation: 'run', jobId: 'review' },
      {
        operation: 'open',
        jobId: 'review',
        args: { file: 'a' },
        action: 'resumed',
        conversationId,
      },
    ]);
  });

  it('starts a new conversation when the agent no longer keeps it: `conversation-gone`', async () => {
    await started();
    idle();
    await exits();
    driver.resumable = false;

    const opened = pending(units.open(KEY));
    await settle();
    hook('/ready');

    await expect(opened).resolves.toEqual({
      action: 'started',
      reason: 'conversation-gone',
      state: 'idle',
    });
  });

  it('starts a new conversation with `fresh`, ending a live session first: `fresh-on-request`', async () => {
    await started();
    hook('/turn-ended-with-a-task');

    const opened = pending(units.open(KEY, { fresh: true }));
    await listHost();
    hook('/ready');

    await expect(opened).resolves.toEqual({
      action: 'started',
      reason: 'fresh-on-request',
      state: 'idle',
      stoppedTasks: [{ id: 'a1', type: 'general-purpose' }],
    });
    expect(recordOf()?.history).toMatchObject([
      { operation: 'run' },
      { operation: 'open', action: 'started', reason: 'fresh-on-request' },
    ]);
  });

  it('is refused `wrong-state` with `fresh` on `starting`', async () => {
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    await ran;
    hook('/ready');

    await expect(units.open(KEY, { fresh: true })).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'starting',
    });
  });

  it('is refused `unknown-job` when the last run’s job is gone', async () => {
    await started();
    idle();
    await exits();
    refusals.set('explain', new CockpitError('unknown-job', 'Gone.', { jobId: 'explain' }));

    await expect(units.open(KEY)).rejects.toMatchObject({ code: 'unknown-job' });
  });
});

describe('the operations on one key', () => {
  beforeEach(() => open());

  it('run one at a time: each acts on the state the one before left', async () => {
    const first = pending(units.run('explain', { file: 'a' }));
    const second = pending(units.run('explain', { file: 'a' }));
    const send = pending(units.send(KEY, 'Hello'));
    await settle();
    hook('/start-and-take');

    await expect(first).resolves.toEqual({ action: 'started', state: 'busy' });
    await expect(second).rejects.toMatchObject({ code: 'wrong-state', state: 'busy' });
    await expect(send).rejects.toMatchObject({ code: 'wrong-state', state: 'busy' });
    expect(driver.launches).toHaveLength(1);
  });

  it('go on after one failed', async () => {
    driver.failNextLaunch(new Error('No launch.'));
    const failed = pending(units.run('explain', { file: 'a' }));
    const next = pending(units.run('explain', { file: 'a' }));
    await settle();
    hook('/start-and-take');

    await expect(failed).rejects.toThrow('No launch.');
    await expect(next).resolves.toEqual({ action: 'started', state: 'busy' });
  });

  it('do not wait for another key’s', async () => {
    const one = pending(units.run('explain', { file: 'a' }));
    const two = pending(units.run('explain', { file: 'b' }));
    await settle();
    hook('/start-and-take', 'explain-b');

    await expect(two).resolves.toEqual({ action: 'started', state: 'busy' });
    hook('/start-and-take');
    await expect(one).resolves.toEqual({ action: 'started', state: 'busy' });
  });
});

describe('an interrupt', () => {
  const RECORDED: UnitRecord = {
    key: KEY,
    conversationId: 'c-recorded',
    earlierConversations: [],
    history: [],
    directory: '.',
    launchSettings: { part: null },
  };

  /** Reports what the transcript records of the key's session, as the driver does outside the hooks. */
  function interruptionRecorded(): void {
    driver.follows.at(-1)?.report([{ type: 'interrupted' }]);
  }

  it('has nothing to interrupt on a key with no record: no state, no key sent', async () => {
    await open();

    await expect(units.interrupt(KEY)).resolves.toEqual({ action: 'nothing-to-interrupt' });
    expect(host.writes).toEqual([]);
  });

  it('has nothing to interrupt on a recorded key with no session in this process: `ended`', async () => {
    await open({ records: [RECORDED] });

    await expect(units.interrupt(KEY)).resolves.toEqual({
      action: 'nothing-to-interrupt',
      state: 'ended',
    });
    expect(host.writes).toEqual([]);
  });

  it('has nothing to interrupt on an `idle` session', async () => {
    await open();
    await started();
    idle();

    await expect(units.interrupt(KEY)).resolves.toEqual({
      action: 'nothing-to-interrupt',
      state: 'idle',
    });
    expect(host.writes).toEqual([]);
  });

  it('asked while a send types, waits for that send, then stops the turn the send began', async () => {
    await open();
    await started();
    idle();
    const sent = pending(units.send(KEY, 'Hello'));
    await settle();

    const interrupted = pending(units.interrupt(KEY));
    await settle();
    expect(host.writes.at(-1)).not.toBe(`${KEY} Escape`);
    hook(`${PROMPT_PATH}Hello`);
    await expect(sent).resolves.toEqual({ action: 'sent', state: 'busy' });
    await settle();
    interruptionRecorded();

    await expect(interrupted).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    expect(host.writes.slice(-2)).toEqual([`${KEY} C-y`, `${KEY} Escape`]);
  });

  it('makes the operations asked after it wait for it to settle, each then reading the state', async () => {
    await open();
    await started();

    const interrupted = pending(units.interrupt(KEY));
    const sent = pending(units.send(KEY, 'Hello'));
    await settle();
    host.show(KEY, stubScreen('input-box'));
    interruptionRecorded();
    await expect(interrupted).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    await settle();
    hook(`${PROMPT_PATH}Hello`);

    await expect(sent).resolves.toEqual({ action: 'sent', state: 'busy' });
  });

  it('is refused once the units of work are closed', async () => {
    await open();
    await started();
    void units.close();

    await expect(units.interrupt(KEY)).rejects.toBeInstanceOf(SessionsClosedError);
    expect(host.writes).toEqual([]);
  });
});

describe('an end', () => {
  const RECORDED: UnitRecord = {
    key: KEY,
    conversationId: 'c-recorded',
    earlierConversations: [],
    history: [],
    directory: '.',
    launchSettings: { part: null },
  };
  const TASK = { id: 'a1', type: 'general-purpose' };

  /** Reports what the transcript records of the key's session, as the driver does outside the hooks. */
  function interruptionRecorded(): void {
    driver.follows.at(-1)?.report([{ type: 'interrupted' }]);
  }

  it('has nothing to end on a key with no record: no state, nothing signalled', async () => {
    await open();

    await expect(units.end(KEY)).resolves.toEqual({ action: 'nothing-to-end' });
    expect(signals).toEqual([]);
  });

  it('has nothing to end on a recorded key with no session in this process: `ended`', async () => {
    await open({ records: [RECORDED] });

    await expect(units.end(KEY)).resolves.toEqual({ action: 'nothing-to-end', state: 'ended' });
  });

  it('has nothing to end on an `ended` session', async () => {
    await open();
    await started();
    idle();
    await exits();

    await expect(units.end(KEY)).resolves.toEqual({ action: 'nothing-to-end', state: 'ended' });
    expect(signals).toEqual([]);
  });

  it('is refused on a `starting` session, with its state: one past its start-up dialog', async () => {
    await open();
    host.show(KEY, stubScreen('trust-folder'));
    const ran = pending(units.run('explain', { file: 'a' }));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    await expect(ran).resolves.toMatchObject({ state: 'waiting' });
    hook('/ready');

    await expect(units.end(KEY)).rejects.toMatchObject({
      code: 'wrong-state',
      key: KEY,
      state: 'starting',
    });
    expect(signals).toEqual([]);
  });

  it('ends an `idle` session, `app`, and resolves once its process is gone, with the tasks it stopped', async () => {
    await open();
    await started();
    hook('/turn-ended-with-a-task');

    const ended = pending(units.end(KEY));
    await settle();
    expect(signals).toEqual([`${KEY} SIGTERM`]);
    await listHost();

    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'app' });
    expect(host.writes).toEqual([]);
  });

  it('interrupts the turn of a `busy` session first, then ends it', async () => {
    await open();
    await started();

    const ended = pending(units.end(KEY));
    await settle();
    expect(host.writes).toEqual([`${KEY} Escape`]);
    expect(signals).toEqual([]);
    interruptionRecorded();
    await settle();
    expect(signals).toEqual([`${KEY} SIGTERM`]);
    await listHost();

    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('ends a `busy` session whose interrupt was not confirmed, all the same', async () => {
    await open();
    await started();

    const ended = pending(units.end(KEY));
    await vi.advanceTimersByTimeAsync(driver.interrupting.boundMs);
    expect(signals).toEqual([`${KEY} SIGTERM`]);
    await listHost();

    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(host.writes).toEqual([`${KEY} Escape`]);
  });

  it('ends a session waiting in the terminal at a start-up dialog at once, no key pressed: `app`, never `declined`', async () => {
    await open();
    host.show(KEY, stubScreen('trust-folder'));
    const ran = pending(units.run('explain', { file: 'a' }));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    await expect(ran).resolves.toMatchObject({ state: 'waiting' });

    const ended = pending(units.end(KEY));
    await settle();
    expect(signals).toEqual([`${KEY} SIGTERM`]);
    await listHost();

    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(host.writes).toEqual([]);
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('waits for an end under way, its reason kept, and gives the tasks that end stopped', async () => {
    await open();
    await started();
    hook('/turn-ended-with-a-task');
    exitOnSignal = false;
    pending(sessions.end(KEY, 'session-cap'));
    await settle();

    const ended = pending(units.end(KEY));
    await settle();
    await exits();

    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
    expect(signals).toEqual([`${KEY} SIGTERM`]);
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'session-cap' });
  });

  it('ends `app` a session whose agent exits by itself while it is asked to end', async () => {
    await open();
    await started();
    idle();
    exitOnSignal = false;

    const ended = pending(units.end(KEY));
    await settle();
    hook('/agent-exit');
    await exits();

    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('hears a hook that comes once the session is being ended, which changes nothing of the end', async () => {
    await open();
    await started();
    idle();
    exitOnSignal = false;

    const ended = pending(units.end(KEY));
    await settle();
    hook('/prompt-taken');
    expect(sessionOf()?.state).toBe('busy');
    await exits();

    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'app' });
    expect(host.writes).toEqual([]);
  });

  it('makes a send asked after it wait for it, then resume the ended session', async () => {
    await open();
    await started();
    idle();
    exitOnSignal = false;

    const ended = pending(units.end(KEY));
    const sent = pending(units.send(KEY, 'Hello'));
    await settle();
    expect(host.writes).toEqual([]);
    await exits();
    await expect(ended).resolves.toMatchObject({ action: 'ended' });
    await settle();
    hook('/start-and-take');

    await expect(sent).resolves.toEqual({ action: 'resumed', state: 'busy' });
    expect(driver.launches[1]).toMatchObject({ resume: true, prompt: 'Hello' });
  });

  it('fails `internal-failure` with the host’s failure when the kill fails, the session left live; a later end ends it', async () => {
    await open();
    await started();
    idle();
    exitOnSignal = false;
    const failure = new SessionHostError('host-failed', 'tmux failed.');
    host.failNextKill(failure);

    const failed = pending(units.end(KEY));
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    const refusal = await failed.catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CockpitError);
    expect(refusal).toMatchObject({
      code: 'internal-failure',
      where: 'session-host',
      cause: failure,
    });
    expect(sessionOf()?.state).toBe('idle');

    const ended = pending(units.end(KEY));
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    await expect(ended).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(host.kills).toEqual([KEY]);
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('is refused once the units of work are closed: nothing signalled', async () => {
    await open();
    await started();
    idle();
    void units.close();

    await expect(units.end(KEY)).rejects.toBeInstanceOf(SessionsClosedError);
    expect(signals).toEqual([]);
  });

  it('signals and kills nothing more once the core is closed while it waits for the agent to exit', async () => {
    await open();
    await started();
    idle();
    exitOnSignal = false;
    const ended = pending(units.end(KEY));
    await settle();
    expect(signals).toEqual([`${KEY} SIGTERM`]);

    void units.close();
    sessions.close();

    await expect(ended).rejects.toBeInstanceOf(SessionsClosedError);
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    expect(host.kills).toEqual([]);
    expect(signals).toEqual([`${KEY} SIGTERM`]);
  });
});

describe('closing the units of work', () => {
  beforeEach(() => open());

  /** Closes as the cockpit does: the units of work, then the sessions core. */
  function close(): Promise<void> {
    const closed = units.close();
    sessions.close();
    return closed;
  }

  it('makes no folder for an operation under way once closed', async () => {
    let checked = () => {};
    checking = new Promise((resolve) => {
      checked = resolve;
    });
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();

    void close();
    checked();

    await expect(ran).rejects.toThrow(SessionsClosedError);
    expect(made).toEqual([]);
    expect(driver.launches).toEqual([]);
  });

  it('starts no session for an admission under way once closed, the sessions core not closed yet', async () => {
    await started();
    idle();
    await exits();
    let answer: (kept: boolean) => void = () => {};
    driver.canResume = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();

    // The cockpit's close awaits the handler's before it closes the sessions core.
    const closed = units.close();
    answer(true);
    await settle();

    await expect(ran).rejects.toThrow(SessionsClosedError);
    expect(driver.launches).toHaveLength(1);
    expect(host.starts).toHaveLength(1);
    await closed;
  });

  it('settles once the record writes under way are done', async () => {
    const release = records.holdPuts();
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    hook('/start-and-take');
    await settle();
    let settled = false;
    const closed = close().then(() => {
      settled = true;
    });

    await settle();
    expect(settled).toBe(false);
    release();
    await closed;

    expect(recordOf()?.conversationId).toBe(driver.launches[0]?.conversationId);
    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
  });

  it('writes no record once closed: a launch the close rejected is not recorded', async () => {
    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    expect(driver.launches).toHaveLength(1);

    await close();
    await settle();

    await expect(ran).rejects.toThrow(SessionsClosedError);
    expect(recordOf()).toBeUndefined();
    expect(records.puts).toBe(0);
  });

  it('refuses every later run, send and open: nothing launched, signalled or killed', async () => {
    await started();
    idle();
    exitOnSignal = false;
    await close();

    await expect(units.run('review', { file: 'a' })).rejects.toThrow(SessionsClosedError);
    await expect(units.send(KEY, 'Hello')).rejects.toThrow(SessionsClosedError);
    await expect(units.open(KEY, { fresh: true })).rejects.toThrow(SessionsClosedError);
    await vi.advanceTimersByTimeAsync(2 * driver.ending.boundMs);

    expect(driver.launches).toHaveLength(1);
    expect(signals).toEqual([]);
    expect(host.kills).toEqual([]);
    expect(made).toEqual(['.']);
  });

  it('rejects each operation still queued, at once: none of them runs', async () => {
    await started();
    idle();
    exitOnSignal = false;
    // A send under way: the agent has not taken its prompt yet.
    const sending = pending(units.send(KEY, 'Hello'));
    const fresh = pending(units.run('explain', { file: 'a' }, { fresh: true }));
    const opened = pending(units.open(KEY, { fresh: true }));
    await settle();
    void close();

    await expect(fresh).rejects.toThrow(SessionsClosedError);
    await expect(opened).rejects.toThrow(SessionsClosedError);
    await expect(sending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(2 * driver.ending.boundMs);
    expect(driver.launches).toHaveLength(1);
    expect(signals).toEqual([]);
    expect(host.kills).toEqual([]);
  });
});

describe('the cap on live sessions', () => {
  it('ends the `idle` session idle longest to make room for a start: `session-cap`', async () => {
    await open({ maxSessions: 2 });
    await started('explain', 'a');
    await started('explain', 'b');
    idle('explain-b');
    vi.advanceTimersByTime(1000);
    idle('explain-a');

    const ran = pending(units.run('explain', { file: 'c' }));
    await listHost();
    hook('/start-and-take', 'explain-c');

    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(sessions.session('explain-b')).toMatchObject({ state: 'ended', reason: 'session-cap' });
    expect(sessions.session('explain-a')?.state).toBe('idle');
  });

  it('ends no session at work, with a background task, or with a terminal attached: `session-cap-reached`', async () => {
    await open({ maxSessions: 3 });
    await started('explain', 'a');
    await started('explain', 'b');
    hook('/turn-ended-with-a-task', 'explain-b');
    await started('explain', 'c');
    idle('explain-c');
    host.attachTerminals('explain-c', 1);

    await expect(units.run('explain', { file: 'd' })).rejects.toMatchObject({
      code: 'session-cap-reached',
      cap: 3,
      live: ['explain-a', 'explain-b', 'explain-c'],
    });
    expect(driver.launches).toHaveLength(3);
    expect(signals).toEqual([]);
  });

  it('lets two starts at once never pass one free place', async () => {
    await open({ maxSessions: 1 });

    const one = pending(units.run('explain', { file: 'a' }));
    const two = pending(units.run('explain', { file: 'b' }));
    await settle();

    await expect(two).rejects.toMatchObject({ code: 'session-cap-reached', live: ['explain-a'] });
    hook('/start-and-take');
    await expect(one).resolves.toMatchObject({ action: 'started' });
  });

  it('counts no session for a prompt typed into a live one', async () => {
    await open({ maxSessions: 1 });
    await started();
    idle();

    const ran = pending(units.run('explain', { file: 'a' }));
    await settle();
    hook(`${PROMPT_PATH}Explain a.`);

    await expect(ran).resolves.toEqual({ action: 'sent', state: 'busy' });
  });

  it('refuses a send and a run on the key of a session it is ending, until it is gone', async () => {
    await open({ maxSessions: 1 });
    await started('explain', 'a');
    idle('explain-a');
    exitOnSignal = false;

    const ran = pending(units.run('explain', { file: 'b' }));
    await settle();
    expect(signals).toEqual(['explain-a SIGTERM']);
    const sent = pending(units.send('explain-a', 'Hello'));
    const rerun = pending(units.run('explain', { file: 'a' }));
    await settle();

    expect(host.writes.filter((write) => write.startsWith('explain-a '))).toEqual([]);
    await expect(sent).rejects.toMatchObject({ code: 'wrong-state', key: 'explain-a' });
    await expect(rerun).rejects.toMatchObject({ code: 'wrong-state', key: 'explain-a' });
    await exits('explain-a');
    hook('/start-and-take', 'explain-b');
    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
  });

  it('ends no session a send began typing into while room was being made: the send is taken, the start refused `session-cap-reached`', async () => {
    await open({ maxSessions: 1 });
    await started('explain', 'a');
    idle('explain-a');
    const counted = host.holdNextCount();

    const ran = pending(units.run('explain', { file: 'b' }));
    await settle();
    const sent = pending(units.send('explain-a', 'Hello'));
    await settle();
    counted.open();
    await settle();
    hook(`${PROMPT_PATH}Hello`, 'explain-a');

    await expect(sent).resolves.toEqual({ action: 'sent', state: 'busy' });
    await expect(ran).rejects.toMatchObject({ code: 'session-cap-reached', live: ['explain-a'] });
    expect(signals).toEqual([]);
  });

  it('waits for a session the cockpit is already ending to make room, rather than end another', async () => {
    await open({ maxSessions: 1 });
    await started('explain', 'a');
    idle('explain-a');
    exitOnSignal = false;
    const ending = pending(sessions.end('explain-a', 'app'));
    await settle();

    const ran = pending(units.run('explain', { file: 'b' }));
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    await ending;
    hook('/start-and-take', 'explain-b');

    await expect(ran).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(sessions.session('explain-a')).toMatchObject({ state: 'ended', reason: 'app' });
    expect(signals).toEqual(['explain-a SIGTERM']);
  });

  it('makes room for a resume, an open and a send that start a session', async () => {
    await open({ maxSessions: 1 });
    await started('explain', 'a');
    idle('explain-a');
    await exits('explain-a');
    await started('explain', 'b');
    idle('explain-b');

    const opened = pending(units.open('explain-a'));
    await listHost();
    hook('/ready', 'explain-a');

    await expect(opened).resolves.toEqual({ action: 'resumed', state: 'idle' });
    expect(sessions.session('explain-b')).toMatchObject({ state: 'ended', reason: 'session-cap' });
  });
});

describe('the records of the units of work', () => {
  const RECORDED: UnitRecord = {
    key: 'explain-r',
    conversationId: 'c-recorded',
    earlierConversations: ['c-before'],
    history: [
      {
        operation: 'run',
        jobId: 'explain',
        args: { file: 'r' },
        at: '2026-11-20T09:00:00.000Z',
        action: 'started',
        conversationId: 'c-recorded',
      },
    ],
    directory: '.',
    launchSettings: { part: null },
  };

  it('lists a recorded key with no live session `ended`, with its record and whether it can resume', async () => {
    driver.resumable = false;
    await open({ records: [RECORDED] });

    expect(units.list()).toEqual([
      {
        key: 'explain-r',
        state: 'ended',
        since: T0.toISOString(),
        canResume: false,
        reason: 'lost',
        record: {
          conversationId: 'c-recorded',
          earlierConversations: ['c-before'],
          history: RECORDED.history,
        },
      },
    ]);
    expect(driver.resumeQuestions).toMatchObject([
      { conversationId: 'c-recorded', directory: APP, environment: { PATH: '/usr/bin' } },
    ]);
  });

  it('resumes a recorded key’s conversation at its next run', async () => {
    await open({ records: [RECORDED] });

    const ran = pending(units.run('explain', { file: 'r' }));
    await settle();
    hook('/start-and-take', 'explain-r');

    await expect(ran).resolves.toEqual({ action: 'resumed', state: 'busy' });
    expect(driver.launches[0]).toMatchObject({ conversationId: 'c-recorded', resume: true });
  });

  it('follows the agent to a new conversation (a `/clear`): the one left is an earlier one', async () => {
    await open();
    await started();
    const old = driver.launches[0]?.conversationId;

    hook(`${CONVERSATION_PATH}c-cleared`);
    await settle();

    expect(recordOf()).toMatchObject({ conversationId: 'c-cleared', earlierConversations: [old] });
  });

  it('keeps a fresh start’s conversation, and the one the old agent moved to among the earlier ones, when the move was told before its end', async () => {
    await open();
    await started();
    idle();
    const old = driver.launches[0]?.conversationId;

    const ran = pending(units.run('explain', { file: 'a' }, { fresh: true }));
    // The `/clear` is told while the run waits for its turn: its record follows the run.
    hook(`${CONVERSATION_PATH}c-cleared`);
    await listHost();
    hook('/start-and-take');
    await ran;
    await settle();

    const fresh = driver.launches[1]?.conversationId;
    // Every conversation of the key is its current one or an earlier one: the old agent's last is an earlier one.
    expect(recordOf()).toMatchObject({
      conversationId: fresh,
      earlierConversations: [old, 'c-cleared'],
    });
  });

  it('keeps the conversation it left among the earlier ones when a restart resumes the one the agent moved to', async () => {
    await open();
    await started();
    idle();
    const old = driver.launches[0]?.conversationId;

    const ran = pending(units.run('review', { file: 'a' }));
    hook(`${CONVERSATION_PATH}c-cleared`);
    await listHost();
    hook('/start-and-take');
    await expect(ran).resolves.toMatchObject({ action: 'resumed', reason: 'settings-changed' });
    await settle();

    expect(driver.launches[1]).toMatchObject({ conversationId: 'c-cleared', resume: true });
    expect(recordOf()).toMatchObject({ conversationId: 'c-cleared', earlierConversations: [old] });
  });

  it('tells its followers each change of a record', async () => {
    await open();
    const seen: (string | undefined)[] = [];
    units.follow((list) => seen.push(list[0]?.record?.conversationId));

    await started();

    expect(seen.at(-1)).toBe(driver.launches[0]?.conversationId);
  });

  it('tells every follower each change though one throws, the run done: what it threw goes to the console', async () => {
    await open();
    const thrown = new Error('A follower failed.');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    units.follow((list) => {
      if (list.length > 0) throw thrown;
    });
    const seen: (string | undefined)[] = [];
    units.follow((list) => seen.push(list[0]?.state));

    await started();

    expect(seen.at(-1)).toBe('busy');
    expect(errors).toHaveBeenCalledWith(thrown);
    errors.mockRestore();
  });

  it('lists the keys in the order they were first recorded, a session not recorded yet last', async () => {
    await open({ records: [RECORDED] });
    await started('explain', 'a');
    const pendingRun = pending(units.run('explain', { file: 'b' }));
    await settle();

    expect(units.list().map((session) => session.key)).toEqual([
      'explain-r',
      'explain-a',
      'explain-b',
    ]);
    hook('/start-and-take', 'explain-b');
    await pendingRun;
  });
});
