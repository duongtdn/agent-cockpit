import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Confinement } from '../../src/server/driver.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import {
  createSessions,
  LIVENESS_INTERVAL_MS,
  PROMPT_BOUND_MS,
  READY_BOUND_MS,
  SCREEN_INTERVAL_MS,
  type Sessions,
  SessionsClosedError,
  START_DEADLINE_MS,
} from '../../src/server/sessions/sessions.ts';
import { CockpitError, isCockpitError } from '../../src/shared/cockpit-error.ts';
import type { RunResult, Session } from '../../src/shared/session.ts';
import {
  createFakeHost,
  createRecordingHookAccess,
  createStubDriver,
  type FakeHost,
  type RecordingHookAccess,
  STUB_COMMAND,
  type StubDriver,
  stubFolders,
  stubScreen,
} from '../support/sessions-doubles.ts';

const T0 = new Date('2026-11-26T10:00:00.000Z');
const CONFINEMENT: Confinement = {
  stateRoots: ['/state'],
  appAddresses: [{ host: '127.0.0.1', port: 8765 }],
  listener: { host: '127.0.0.1', port: 4000 },
};
const KEY = 'explain-readme';
const DIRECTORY = '/apps/demo';

let host: FakeHost;
let driver: StubDriver;
let access: RecordingHookAccess;
let sessions: Sessions;
let confinement: () => Promise<Confinement>;

beforeEach(() => {
  confinement = async () => CONFINEMENT;
  vi.useFakeTimers({ now: T0 });
  host = createFakeHost();
  driver = createStubDriver();
  access = createRecordingHookAccess();
  sessions = createSessions({
    host,
    driver,
    hooks: access,
    folders: stubFolders(),
    environment: () => ({ PATH: '/usr/bin', HOME: '/home/someone' }),
    confinement: () => confinement(),
  });
});

afterEach(() => {
  sessions.close();
  vi.useRealTimers();
});

/** Sends a stub hook of a session: its path names the events. */
function hook(path: string, key = KEY): void {
  sessions.receive({ key, path, body: {} });
}

/** Lets every pending promise settle, the clock unmoved. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Runs a job's prompt on a key and waits until the agent is launched on the host. */
async function launched(key = KEY, prompt: { prompt?: string } = { prompt: 'Explain README.md' }) {
  const result = sessions.run({ key, directory: DIRECTORY, ...prompt });
  // A run that fails early must not fail the test before it looks.
  result.catch(() => {});
  await settle();
  // In an object: a promise returned as it is would be awaited with the launch.
  return { result };
}

function sessionOf(key = KEY): Session | undefined {
  return sessions.list().find((session) => session.key === key);
}

describe('a run on a key with no session', () => {
  it('launches the agent through the host, with the command the driver gives', async () => {
    await launched();

    expect(driver.launches).toEqual([
      {
        key: KEY,
        conversationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        directory: DIRECTORY,
        files: `/state/sessions/${KEY}`,
        hooks: { url: 'http://127.0.0.1:4000', token: `token-of-${KEY}` },
        prompt: 'Explain README.md',
        environment: { PATH: '/usr/bin', HOME: '/home/someone' },
        confinement: CONFINEMENT,
      },
    ]);
    expect(host.starts).toEqual([
      {
        name: KEY,
        folder: DIRECTORY,
        command: STUB_COMMAND.command,
        args: STUB_COMMAND.args,
        environment: { set: STUB_COMMAND.environment, remove: expect.any(Array) },
        size: { columns: 120, rows: 40 },
      },
    ]);
  });

  it("gives the agent exactly the driver's environment: every other variable of the server's is removed", async () => {
    process.env.COCKPIT_SESSIONS_TEST = 'not for the agent';
    try {
      await launched();
    } finally {
      delete process.env.COCKPIT_SESSIONS_TEST;
    }

    const { remove } = host.starts[0]?.environment ?? { remove: [] };
    expect(remove).toContain('COCKPIT_SESSIONS_TEST');
    expect(remove).not.toContain('STUB_AGENT');
  });

  it('mints a new conversation id at each launch', async () => {
    await launched('one');
    await launched('two');

    const [first, second] = driver.launches;
    expect(first?.conversationId).not.toBe(second?.conversationId);
  });

  it('lists the session `starting` from the launch, since then', async () => {
    await launched();

    expect(sessions.list()).toEqual([{ key: KEY, state: 'starting', since: T0.toISOString() }]);
  });

  it('resolves when the session leaves `starting`: `busy`, the prompt taken', async () => {
    const { result } = await launched();
    let settled: RunResult | undefined;
    void result.then((value) => {
      settled = value;
    });

    hook('/ready');
    await settle();
    expect(settled).toBeUndefined();
    expect(sessionOf()?.state).toBe('starting');

    vi.advanceTimersByTime(1500);
    hook('/prompt-taken');

    await expect(result).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'busy',
      since: new Date(T0.getTime() + 1500).toISOString(),
    });
  });

  it('resolves at `idle` when it launched no prompt and the agent is ready', async () => {
    const { result } = await launched(KEY, {});

    hook('/ready');

    await expect(result).resolves.toEqual({ action: 'started', state: 'idle' });
    expect(driver.launches[0]).not.toHaveProperty('prompt');
  });

  it('reads the events of one hook in order', async () => {
    const { result } = await launched();

    hook('/start-and-take');

    await expect(result).resolves.toEqual({ action: 'started', state: 'busy' });
  });

  it('refuses a text that is no session key, launching nothing', async () => {
    await expect(sessions.run({ key: 'Not a key', directory: DIRECTORY })).rejects.toThrow(
      TypeError,
    );
    expect(driver.launches).toEqual([]);
  });
});

describe('a run on a key that has a session', () => {
  it.each([
    ['starting', [] as string[]],
    ['busy', ['/prompt-taken']],
    ['idle', ['/prompt-taken', '/turn-ended']],
  ])('is refused on `%s` with `wrong-state` and the state', async (state, hooks) => {
    await launched();
    for (const path of hooks) hook(path);

    const refusal = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Again' });

    await expect(refusal).rejects.toSatisfy((error) => isCockpitError(error, 'wrong-state'));
    await expect(refusal).rejects.toMatchObject({ key: KEY, state });
    expect(driver.launches).toHaveLength(1);
  });

  it('is refused on `ended` with `wrong-state`, until a run resumes', async () => {
    await launched();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(
      sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Again' }),
    ).rejects.toMatchObject({ code: 'wrong-state', key: KEY, state: 'ended' });
  });

  it('is refused for a second run of the same key at once, before the first launched', async () => {
    const first = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'One' });
    const second = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Two' });

    await expect(second).rejects.toMatchObject({ code: 'wrong-state', state: 'starting' });
    await settle();
    hook('/prompt-taken');
    await expect(first).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(host.starts).toHaveLength(1);
  });
});

describe('a session that an earlier run left on the host', () => {
  it('is refused with `session-exists`: nothing is written for it, nothing listed', async () => {
    host.leave(KEY);

    const refusal = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hello' });

    await expect(refusal).rejects.toBeInstanceOf(SessionHostError);
    await expect(refusal).rejects.toMatchObject({ reason: 'session-exists' });
    expect(driver.launches).toEqual([]);
    expect(access.granted).toEqual([]);
    expect(sessions.list()).toEqual([]);
  });
});

describe('a launch that fails', () => {
  it('rejects when the host cannot tell whether an earlier session holds the key; the key stays free', async () => {
    host.failIsLive(true);

    await expect(
      sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' }),
    ).rejects.toMatchObject({ reason: 'host-failed' });
    expect(sessions.list()).toEqual([]);

    host.failIsLive(false);
    await launched();
    expect(sessionOf()?.state).toBe('starting');
  });

  it('rejects with what the host said; the session is no longer listed, its token revoked', async () => {
    const failure = new SessionHostError('no-folder', 'No such folder.');
    host.failNextStart(failure);
    const seen: Session[][] = [];
    sessions.follow((list) => seen.push([...list]));

    await expect(sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' })).rejects.toBe(
      failure,
    );

    expect(sessions.list()).toEqual([]);
    expect(access.revoked).toEqual([KEY]);
    expect(seen.map((list) => list.map((session) => session.state))).toEqual([
      [],
      ['starting'],
      [],
    ]);
  });

  it('rejects with what the confinement could not be read for, before anything is written or granted', async () => {
    const failure = new CockpitError('no-app-port', 'No port of the app is known.');
    confinement = async () => {
      throw failure;
    };

    await expect(sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' })).rejects.toBe(
      failure,
    );
    expect(access.granted).toEqual([]);
    expect(driver.launches).toEqual([]);
    expect(host.starts).toEqual([]);
    expect(sessions.list()).toEqual([]);
  });

  it("rejects with the driver's error, the host never asked", async () => {
    const failure = new CockpitError('agent-not-found', 'No agent.', { command: 'claude' });
    driver.failNextLaunch(failure);

    await expect(sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' })).rejects.toBe(
      failure,
    );
    expect(host.starts).toEqual([]);
    expect(sessions.list()).toEqual([]);
  });

  it('may be run again afterwards', async () => {
    host.failNextStart(new SessionHostError('host-failed', 'tmux failed.'));
    await expect(sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' })).rejects.toThrow();

    const { result: again } = await launched();
    hook('/prompt-taken');

    await expect(again).resolves.toEqual({ action: 'started', state: 'busy' });
  });
});

describe('a launch whose agent never reports', () => {
  it(`is ended after ${START_DEADLINE_MS / 1000} s with nothing on its screen, and refused \`unobservable\`, with the driver's cause`, async () => {
    const { result } = await launched();

    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS - 1);
    expect(host.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).rejects.toSatisfy((error) => isCockpitError(error, 'unobservable'));
    await expect(result).rejects.toMatchObject({ key: KEY, cause: driver.silentStartCause });
    expect(host.kills).toEqual([KEY]);
    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'ended',
      since: new Date(T0.getTime() + START_DEADLINE_MS).toISOString(),
      canResume: true,
      reason: 'unobservable',
    });
    expect(access.revoked).toEqual([KEY]);
  });

  it('counts the wait from the start on the host, not from the run', async () => {
    const held = host.holdNextStart();
    const result = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' });
    result.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    held.open();
    await settle();

    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS - 1);
    expect(host.kills).toEqual([]);
  });

  it('is not ended once the agent reported ready, even before it took the prompt', async () => {
    await launched();
    hook('/ready');

    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS * 2);

    expect(host.kills).toEqual([]);
  });

  it('rejects with the host failure when it cannot be ended; the session ends when it goes', async () => {
    const failure = new SessionHostError('host-failed', 'tmux failed.');
    const { result } = await launched();
    host.failNextKill(failure);

    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS);

    await expect(result).rejects.toBe(failure);
    expect(sessionOf()?.state).toBe('starting');
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'unobservable' });
  });
});

/** The time `ms` after the launch, as `since` holds it. */
function at(ms: number): string {
  return new Date(T0.getTime() + ms).toISOString();
}

/** Lets the screen be read once more: the next read is at most one interval away. */
const nextRead = () => vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);

describe("a launch's screen, read until its agent's first hook", () => {
  it(`is read every ${SCREEN_INTERVAL_MS} ms from the launch, and no more once a hook came`, async () => {
    await launched();

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);
    expect(host.screenReads).toBe(4);

    hook('/ready');
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);
    expect(host.screenReads).toBe(4);
  });

  it('makes the session wait in the terminal at a dialog, named; the run resolves at `waiting`', async () => {
    const { result } = await launched();
    host.show(KEY, stubScreen('trust-folder'));

    await nextRead();

    await expect(result).resolves.toEqual({ action: 'started', state: 'waiting' });
    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'waiting',
      since: at(SCREEN_INTERVAL_MS),
      pending: [{ kind: 'terminal', dialog: 'trust-folder' }],
    });
  });

  it('names no dialog the driver does not know', async () => {
    const { result } = await launched();
    host.show(KEY, stubScreen('dialog'));

    await nextRead();

    await expect(result).resolves.toEqual({ action: 'started', state: 'waiting' });
    expect(sessionOf()).toMatchObject({ state: 'waiting', pending: [{ kind: 'terminal' }] });
  });

  it("follows the dialog's name while it waits, its `since` kept, and tells only a change", async () => {
    await launched(KEY, {});
    const seen: Session[][] = [];
    sessions.follow((list) => seen.push([...list]));
    host.show(KEY, stubScreen('onboarding'));
    await nextRead();
    await nextRead();

    host.show(KEY, stubScreen('login'));
    await nextRead();
    await nextRead();

    expect(seen.map((list) => list[0])).toEqual([
      { key: KEY, state: 'starting', since: at(0) },
      {
        key: KEY,
        state: 'waiting',
        since: at(SCREEN_INTERVAL_MS),
        pending: [{ kind: 'terminal', dialog: 'onboarding' }],
      },
      {
        key: KEY,
        state: 'waiting',
        since: at(SCREEN_INTERVAL_MS),
        pending: [{ kind: 'terminal', dialog: 'login' }],
      },
    ]);
  });

  it('waits as long as the dialog shows: a person may answer at any time', async () => {
    await launched();
    host.show(KEY, stubScreen('trust-folder'));

    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS * 6);

    expect(host.kills).toEqual([]);
    expect(sessionOf()?.state).toBe('waiting');
  });

  it('goes on once the person answered: `idle` at the first hook, launched with no prompt', async () => {
    await launched(KEY, {});
    host.show(KEY, stubScreen('trust-folder'));
    await nextRead();
    const seen: string[] = [];
    sessions.follow((list) => seen.push(list[0]?.state ?? 'none'));
    host.show(KEY, stubScreen('ready'));
    await nextRead();

    hook('/ready');

    expect(seen).toEqual(['waiting', 'idle']);
    expect(sessionOf()).toEqual({ key: KEY, state: 'idle', since: at(SCREEN_INTERVAL_MS * 2) });
  });

  it('goes on once the person answered: `starting` at the first hook, `busy` when the prompt is taken', async () => {
    await launched();
    host.show(KEY, stubScreen('bypass-permissions'));
    await nextRead();
    const seen: string[] = [];
    sessions.follow((list) => seen.push(list[0]?.state ?? 'none'));

    hook('/ready');
    hook('/prompt-taken');

    expect(seen).toEqual(['waiting', 'starting', 'busy']);
  });

  it('is `ended`, `declined`, with its dialog, when the process goes from the dialog with no hook', async () => {
    const { result } = await launched();
    host.show(KEY, stubScreen('trust-folder'));
    await nextRead();
    await expect(result).resolves.toMatchObject({ state: 'waiting' });

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()).toMatchObject({
      state: 'ended',
      reason: 'declined',
      dialog: 'trust-folder',
    });
  });

  it('is `declined` when the agent says it ends as it leaves the dialog', async () => {
    await launched();
    host.show(KEY, stubScreen('bypass-permissions'));
    await nextRead();

    hook('/ending');
    expect(sessionOf()?.state).toBe('waiting');
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()).toMatchObject({
      state: 'ended',
      reason: 'declined',
      dialog: 'bypass-permissions',
    });
  });

  it('is `declined` with no dialog named when the driver did not know it', async () => {
    await launched();
    host.show(KEY, stubScreen('dialog'));
    await nextRead();

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'declined' });
    expect(sessionOf()).not.toHaveProperty('dialog');
  });

  it('is `lost` when the process goes once the dialog was answered and the input box shows', async () => {
    await launched();
    host.show(KEY, stubScreen('trust-folder'));
    await nextRead();
    host.show(KEY, stubScreen('ready'));
    await nextRead();

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'lost' });
    expect(sessionOf()).not.toHaveProperty('dialog');
  });

  it('is `lost` when the process goes past the dialog, after its first hook', async () => {
    await launched();
    host.show(KEY, stubScreen('trust-folder'));
    await nextRead();
    hook('/ready');

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'lost' });
  });

  it("takes no screen a person scrolled back for the agent's", async () => {
    await launched();
    host.show(KEY, stubScreen('trust-folder'));
    host.scrollBack(KEY, true);
    await nextRead();
    expect(sessionOf()?.state).toBe('starting');

    host.scrollBack(KEY, false);
    await nextRead();
    expect(sessionOf()?.state).toBe('waiting');
  });

  it('goes on reading after a read failed', async () => {
    await launched();
    host.exit(KEY);
    await nextRead();
    host.leave(KEY);
    host.show(KEY, stubScreen('login'));

    await nextRead();

    expect(sessionOf()).toMatchObject({ state: 'waiting', pending: [{ dialog: 'login' }] });
  });
});

describe("a launch's deadline", () => {
  it(`comes ${READY_BOUND_MS / 1000} s after the input box first shows, sooner than with nothing on screen`, async () => {
    const { result } = await launched();
    host.show(KEY, stubScreen('ready'));

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS + READY_BOUND_MS - 1);
    expect(host.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).rejects.toMatchObject({ code: 'unobservable', key: KEY });
    expect(sessionOf()).toMatchObject({
      state: 'ended',
      reason: 'unobservable',
      since: at(SCREEN_INTERVAL_MS + READY_BOUND_MS),
    });
  });

  it('gives a box first seen late its whole bound', async () => {
    await launched();
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS - 2 * SCREEN_INTERVAL_MS);
    host.show(KEY, stubScreen('ready'));
    await nextRead();

    await vi.advanceTimersByTimeAsync(READY_BOUND_MS - 1);
    expect(host.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.kills).toEqual([KEY]);
  });

  it('starts again when a dialog leaves the screen, from then', async () => {
    const { result } = await launched();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS * 2);
    await expect(result).resolves.toMatchObject({ state: 'waiting' });
    host.show(KEY, '');
    await nextRead();

    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS - 1);
    expect(host.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(host.kills).toEqual([KEY]);
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'unobservable' });
  });

  it('ends a session whose dialog was answered and whose hooks never come, the box showing', async () => {
    await launched();
    host.show(KEY, stubScreen('trust-folder'));
    await nextRead();
    host.show(KEY, stubScreen('ready'));
    await nextRead();

    await vi.advanceTimersByTimeAsync(READY_BOUND_MS);

    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'unobservable' });
  });
});

describe('a launch prompt that no hook says was taken', () => {
  async function ready(): Promise<{ result: Promise<RunResult> }> {
    const launch = await launched();
    hook('/ready');
    return launch;
  }

  it(`is waited for ${PROMPT_BOUND_MS / 1000} s after the agent is ready, then read on screen: the input box back is \`idle\``, async () => {
    const { result } = await ready();
    host.show(KEY, stubScreen('ready'));

    await vi.advanceTimersByTimeAsync(PROMPT_BOUND_MS - 1);
    expect(sessionOf()?.state).toBe('starting');
    expect(host.screenReads).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ action: 'started', state: 'idle' });
    expect(sessionOf()).toEqual({ key: KEY, state: 'idle', since: at(PROMPT_BOUND_MS) });
  });

  it('waits in the terminal while a panel shows, then is `idle` once the box is back', async () => {
    const { result } = await ready();
    host.show(KEY, stubScreen('dialog'));
    await vi.advanceTimersByTimeAsync(PROMPT_BOUND_MS);
    await expect(result).resolves.toEqual({ action: 'started', state: 'waiting' });
    expect(sessionOf()).toMatchObject({ state: 'waiting', pending: [{ kind: 'terminal' }] });

    host.show(KEY, stubScreen('ready'));
    await nextRead();

    expect(sessionOf()).toMatchObject({ state: 'idle' });
    const reads = host.screenReads;
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);
    expect(host.screenReads).toBe(reads);
  });

  it('is `busy` when the screen shows neither: the agent works on it, and its hooks tell the rest', async () => {
    const { result } = await ready();

    await vi.advanceTimersByTimeAsync(PROMPT_BOUND_MS);

    await expect(result).resolves.toEqual({ action: 'started', state: 'busy' });
    hook('/turn-ended');
    expect(sessionOf()?.state).toBe('idle');
  });

  it('is not read when the prompt is taken in time', async () => {
    const { result } = await ready();
    hook('/prompt-taken');

    await vi.advanceTimersByTimeAsync(PROMPT_BOUND_MS * 2);

    await expect(result).resolves.toEqual({ action: 'started', state: 'busy' });
    expect(host.screenReads).toBe(0);
  });

  it('is not waited for when the launch gave none', async () => {
    await launched(KEY, {});
    hook('/ready');

    await vi.advanceTimersByTimeAsync(PROMPT_BOUND_MS * 2);

    expect(sessionOf()?.state).toBe('idle');
    expect(host.screenReads).toBe(0);
  });

  it('is read no more once the session ended', async () => {
    await ready();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(PROMPT_BOUND_MS);

    expect(host.screenReads).toBe(0);
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'lost' });
  });
});

describe('a hook that arrives while the agent is being started on the host', () => {
  it('is heard: the run resolves once the start is done, and the session is never ended silent', async () => {
    const held = host.holdNextStart();
    const result = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' });
    let settled: RunResult | undefined;
    void result.then((value) => {
      settled = value;
    });
    await settle();

    hook('/start-and-take');
    await settle();
    expect(sessionOf()?.state).toBe('busy');
    expect(settled).toBeUndefined();

    held.open();
    await expect(result).resolves.toEqual({ action: 'started', state: 'busy' });
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS * 2);
    expect(host.kills).toEqual([]);
  });

  it('leaves the launch’s failure to the run when the start then fails', async () => {
    const failure = new SessionHostError('host-failed', 'tmux failed.');
    const held = host.holdNextStart();
    const result = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' });
    result.catch(() => {});
    await settle();

    hook('/ready');
    held.fail(failure);

    await expect(result).rejects.toBe(failure);
    expect(sessionOf()).toBeUndefined();
  });
});

describe('a hook that arrives while the cockpit ends a silent session', () => {
  it('changes nothing: the run is refused `unobservable` and the session ends so', async () => {
    const { result } = await launched();
    const kill = host.holdNextKill();
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS);

    hook('/start-and-take');
    await settle();
    expect(sessionOf()?.state).toBe('starting');
    kill.open();

    await expect(result).rejects.toSatisfy((error) => isCockpitError(error, 'unobservable'));
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'unobservable' });
  });

  it('is heard again once the kill failed: the session still lives', async () => {
    const { result } = await launched();
    host.failNextKill(new SessionHostError('host-failed', 'tmux failed.'));
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS);
    await expect(result).rejects.toThrow(SessionHostError);

    hook('/start-and-take');

    expect(sessionOf()?.state).toBe('busy');
  });

  it('records a later end for what it is, not `unobservable`, once the kill failed', async () => {
    const { result } = await launched();
    host.failNextKill(new SessionHostError('host-failed', 'tmux failed.'));
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS);
    await expect(result).rejects.toThrow(SessionHostError);
    hook('/start-and-take');

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'lost' });
  });
});

describe('closing the sessions core', () => {
  async function closedRun(result: Promise<RunResult>): Promise<void> {
    await expect(result).rejects.toThrow(SessionsClosedError);
    await expect(result).rejects.toSatisfy((error) => !isCockpitError(error));
  }

  it('settles a run that waits for its agent’s first hook; the session is left on the host', async () => {
    const { result } = await launched();

    sessions.close();

    await closedRun(result);
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS * 2);
    expect(host.kills).toEqual([]);
    expect(host.listings).toBe(0);
  });

  it('settles a run still being started on the host, and then starts no timer and no watch', async () => {
    const held = host.holdNextStart();
    const result = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' });
    result.catch(() => {});
    await settle();

    sessions.close();
    held.open();

    await closedRun(result);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS * 2);
    expect(host.kills).toEqual([]);
    expect(host.listings).toBe(0);
  });

  it('stops a run that has not reached the host: nothing is launched, its token revoked', async () => {
    const result = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' });
    result.catch(() => {});
    sessions.close();

    await closedRun(result);
    expect(host.starts).toEqual([]);
    expect(access.revoked).toEqual(access.granted);
    expect(sessionOf()).toBeUndefined();
  });

  it('refuses a run asked afterwards, launching nothing', async () => {
    sessions.close();

    await closedRun(sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' }));
    expect(driver.launches).toEqual([]);
  });

  it('leaves a run that already resolved as it was', async () => {
    const { result } = await launched();
    hook('/prompt-taken');
    await expect(result).resolves.toEqual({ action: 'started', state: 'busy' });

    sessions.close();

    expect(sessionOf()?.state).toBe('busy');
  });
});

describe("a session's states, from the driver's events", () => {
  async function busy(): Promise<void> {
    const { result } = await launched();
    hook('/prompt-taken');
    await result;
  }

  it('is `idle` at the end of a turn, with its last message', async () => {
    await busy();
    vi.advanceTimersByTime(2000);

    hook('/turn-ended');

    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'idle',
      since: new Date(T0.getTime() + 2000).toISOString(),
      lastMessage: 'Done.',
    });
  });

  it('is `idle` with no last message when the turn gave none', async () => {
    await busy();

    hook('/turn-ended-silently');

    expect(sessionOf()).toEqual({ key: KEY, state: 'idle', since: T0.toISOString() });
  });

  it('is `busy` again when it works, and keeps its `since` while it stays busy', async () => {
    await busy();
    hook('/turn-ended');
    vi.advanceTimersByTime(1000);

    hook('/working');
    vi.advanceTimersByTime(1000);
    hook('/working');

    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'busy',
      since: new Date(T0.getTime() + 1000).toISOString(),
    });
  });

  it('changes nothing on a hook that tells nothing, nor on `ready` once started', async () => {
    await busy();
    const seen: Session[][] = [];
    sessions.follow((list) => seen.push([...list]));

    hook('/background');
    hook('/ready');

    expect(seen).toHaveLength(1);
    expect(sessionOf()?.state).toBe('busy');
  });

  it('changes once for one hook that tells several events: its followers see the end', async () => {
    await busy();
    const seen: Session[][] = [];
    sessions.follow((list) => seen.push([...list]));

    hook('/turn-ended-with-a-task');

    expect(seen.slice(1)).toEqual([
      [
        {
          key: KEY,
          state: 'idle',
          since: T0.toISOString(),
          lastMessage: 'Done.',
          backgroundTasks: [{ id: 'a1', type: 'general-purpose' }],
        },
      ],
    ]);
  });

  it('returns from a compaction begun while idle to that idle session, its since kept', async () => {
    await busy();
    hook('/turn-ended');
    const ended = sessionOf();
    vi.advanceTimersByTime(60_000);

    hook('/compaction-began');
    const compacting = sessionOf();
    vi.advanceTimersByTime(8000);
    hook('/compaction-ended');

    expect(compacting).toEqual({
      key: KEY,
      state: 'busy',
      since: new Date(T0.getTime() + 60_000).toISOString(),
    });
    expect(sessionOf()).toEqual(ended);
  });

  it('ignores the hooks of a key it does not know', () => {
    hook('/prompt-taken', 'nobody');

    expect(sessions.list()).toEqual([]);
  });

  it('ignores the hooks of an ended session', async () => {
    await busy();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    hook('/prompt-taken');

    expect(sessionOf()?.state).toBe('ended');
  });
});

describe('the end of a session', () => {
  async function live(): Promise<void> {
    const { result } = await launched();
    hook('/prompt-taken');
    await result;
  }

  it(`is seen by the periodic list of the host, within ${LIVENESS_INTERVAL_MS} ms`, async () => {
    await live();
    vi.advanceTimersByTime(300);
    host.exit(KEY);

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS - 300 - 1);
    expect(sessionOf()?.state).toBe('busy');
    await vi.advanceTimersByTimeAsync(1);

    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'ended',
      since: new Date(T0.getTime() + LIVENESS_INTERVAL_MS).toISOString(),
      canResume: true,
      reason: 'lost',
    });
    expect(driver.resumeQuestions).toEqual([
      { conversationId: driver.launches[0]?.conversationId, directory: DIRECTORY },
    ]);
    expect(access.revoked).toEqual([KEY]);
  });

  it('is `agent-exit` when the agent said it was ending', async () => {
    await live();
    hook('/agent-exit');
    expect(sessionOf()?.state).toBe('busy');

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'agent-exit' });
  });

  it('says the conversation cannot resume when the driver says so, or cannot tell', async () => {
    driver.resumable = false;
    await launched('one');
    driver.resumable = new Error('unreadable');
    await launched('two');

    host.exit('one');
    host.exit('two');
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(
      sessions.list().map((session) => session.state === 'ended' && session.canResume),
    ).toEqual([false, false]);
  });

  it('resolves a launch whose agent is gone before it left `starting`, at `ended`', async () => {
    const { result } = await launched();

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(result).resolves.toEqual({ action: 'started', state: 'ended' });
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'lost' });
  });

  it('lists the host once a tick for every live session, and not at all when none lives', async () => {
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3);
    expect(host.listings).toBe(0);

    await launched('one');
    await launched('two');
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3);
    expect(host.listings).toBe(3);

    host.exit('one');
    host.exit('two');
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    const afterTheEnd = host.listings;
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3);
    expect(host.listings).toBe(afterTheEnd);
  });

  it('does not take a session started while the host was being listed for one gone', async () => {
    await launched('one');
    const held = host.holdNextList();
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await launched('two');
    held.open();
    await settle();

    expect(sessions.list().map((session) => session.state)).toEqual(['starting', 'starting']);
  });

  it('starts no second list while one is unanswered', async () => {
    await launched();
    const held = host.holdNextList();

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3);
    expect(host.listings).toBe(1);
    held.open();
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(host.listings).toBe(2);
  });

  it('goes on listing after the host failed to answer', async () => {
    await launched();
    host.failLists(true);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 2);
    host.failLists(false);
    host.exit(KEY);

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessionOf()?.state).toBe('ended');
  });

  it('stops listing once closed', async () => {
    await launched();
    sessions.close();

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3);

    expect(host.listings).toBe(0);
  });
});

describe('a terminal attached to a session', () => {
  it("is the host's attachment, at the size asked", async () => {
    await launched();

    const attachment = await sessions.attach(KEY, { columns: 80, rows: 24 });

    expect(attachment).toBe(host.attachments[0]);
  });

  it('tells the end of its session at once, without waiting for the periodic list', async () => {
    await launched();
    const attachment = await sessions.attach(KEY, { columns: 80, rows: 24 });

    host.exit(KEY);
    host.attachments[0]?.end();
    await settle();

    expect(attachment).toBeDefined();
    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'lost' });
    expect(host.listings).toBe(0);
  });

  it('rejects when the host fails to attach', async () => {
    await launched();
    const failure = new SessionHostError('host-failed', 'tmux failed.');
    host.failNextAttach(failure);

    await expect(sessions.attach(KEY, { columns: 80, rows: 24 })).rejects.toBe(failure);
    expect(sessionOf()?.state).toBe('starting');
  });

  it('leaves the end to the periodic list when the host cannot tell at the end of a terminal', async () => {
    await launched();
    await sessions.attach(KEY, { columns: 80, rows: 24 });
    host.failIsLive(true);

    host.exit(KEY);
    host.attachments[0]?.end();
    await settle();
    expect(sessionOf()?.state).toBe('starting');

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    expect(sessionOf()?.state).toBe('ended');
  });

  it('asks nothing at the end of a terminal whose session already ended', async () => {
    await launched();
    await sessions.attach(KEY, { columns: 80, rows: 24 });
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    host.failIsLive(true);

    host.attachments[0]?.end();
    await settle();

    expect(sessionOf()).toMatchObject({ state: 'ended', reason: 'lost' });
  });

  it('leaves the session live when only the terminal was detached', async () => {
    await launched();
    const attachment = await sessions.attach(KEY, { columns: 80, rows: 24 });

    await attachment?.detach();
    await settle();

    expect(sessionOf()?.state).toBe('starting');
  });

  it('is nothing for a key with no session, an ended one, or one gone from the host', async () => {
    expect(await sessions.attach('nobody', { columns: 80, rows: 24 })).toBeUndefined();

    await launched('one');
    host.exit('one');
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    expect(await sessions.attach('one', { columns: 80, rows: 24 })).toBeUndefined();

    await launched('two');
    host.exit('two');
    expect(await sessions.attach('two', { columns: 80, rows: 24 })).toBeUndefined();
    await settle();
    expect(sessionOf('two')).toMatchObject({ state: 'ended', reason: 'lost' });
  });

  it('is nothing while the session is not yet on the host', async () => {
    const held = host.holdNextStart();
    const result = sessions.run({ key: KEY, directory: DIRECTORY, prompt: 'Hi' });
    result.catch(() => {});
    await settle();

    expect(await sessions.attach(KEY, { columns: 80, rows: 24 })).toBeUndefined();
    held.open();
  });
});

describe('following the sessions', () => {
  it('gives the list at once, then the whole list at every change, until stopped', async () => {
    const seen: Session[][] = [];
    const stop = sessions.follow((list) => seen.push([...list]));
    expect(seen).toEqual([[]]);

    const { result } = await launched();
    hook('/prompt-taken');
    await result;
    stop();
    hook('/turn-ended');

    expect(seen).toEqual([
      [],
      [{ key: KEY, state: 'starting', since: T0.toISOString() }],
      [{ key: KEY, state: 'busy', since: T0.toISOString() }],
    ]);
  });

  it('gives each follower every change, whoever else follows', async () => {
    const first: number[] = [];
    const second: number[] = [];
    sessions.follow((list) => first.push(list.length));
    const stop = sessions.follow((list) => second.push(list.length));
    stop();
    stop();

    await launched();

    expect(first).toEqual([0, 1]);
    expect(second).toEqual([0]);
  });

  it('lists the sessions in the order they were first run', async () => {
    await launched('b');
    await launched('a');

    expect(sessions.list().map((session) => session.key)).toEqual(['b', 'a']);
  });
});
