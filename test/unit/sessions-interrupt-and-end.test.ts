import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import {
  createSessions,
  LIVENESS_INTERVAL_MS,
  SCREEN_INTERVAL_MS,
  type Sessions,
  SessionsClosedError,
} from '../../src/server/sessions/sessions.ts';
import { createTerminalHolds } from '../../src/server/terminal-hold.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import type { EndResult } from '../../src/shared/session.ts';
import {
  createFakeHost,
  createRecordingHookAccess,
  createStubDriver,
  type FakeHost,
  PROMPT_PATH,
  type StubDriver,
  stubFolders,
  stubScreen,
  withdrawnScreen,
} from '../support/sessions-doubles.ts';

const T0 = new Date('2026-11-28T10:00:00.000Z');
const KEY = 'explain-readme';
const DIRECTORY = '/apps/demo';
const CONVERSATION = '3f2c1a9e-8d4b-4c6a-9e1f-0a7b5c3d2e10';
const PROMPT = 'Explain the tests.';
const TASK = { id: 'a1', type: 'general-purpose' };

let host: FakeHost;
let driver: StubDriver;
let sessions: Sessions;
/** Every signal sent, `<pid> <signal>`; an agent signalled stays until the test makes it go. */
let signals: string[];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  host = createFakeHost();
  driver = createStubDriver();
  signals = [];
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
    signal: (pid, signal) => void signals.push(`${pid} ${signal}`),
  });
});

afterEach(() => {
  sessions.close();
  vi.useRealTimers();
});

function hook(path: string): void {
  sessions.receive({ key: KEY, path, body: {} });
}

/** Reports what the transcript records, as the driver does outside the hooks. */
function recorded(...events: Parameters<StubDriver['follows'][number]['report']>[0]): void {
  driver.follows.at(-1)?.report(events);
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const { boundMs: INTERRUPT_BOUND_MS } = createStubDriver().interrupting;
const { boundMs: ENDING_BOUND_MS } = createStubDriver().ending;

/** Launches a session and brings it to `idle`, its empty input box on screen. */
async function idleSession(): Promise<void> {
  const launched = sessions.launch({
    key: KEY,
    directory: DIRECTORY,
    conversationId: CONVERSATION,
  });
  await settle();
  hook('/ready');
  await launched;
  host.show(KEY, stubScreen('input-box'));
}

/** Brings a session to `busy` on a prompt the agent took, a background task listed before. */
async function busySession(): Promise<void> {
  await idleSession();
  hook('/turn-ended-with-a-task');
  hook(`${PROMPT_PATH}${PROMPT}`);
  host.show(KEY, 'the agent at work');
}

/** Makes the agent's process go, and the core see it. */
async function exits(): Promise<void> {
  host.exit(KEY);
  await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
}

/** Ends the key's session as an app asks, the outcome kept for the test to look at. */
function ending(): Promise<EndResult> {
  const result = sessions.interruptAndEnd(KEY, 'app');
  result.catch(() => {});
  return result;
}

/** The writes into the key's session, without its name. */
function writes(): string[] {
  return host.writes.map((write) => write.slice(KEY.length + 1));
}

describe('an end with no turn to stop', () => {
  it('signals the agent of an idle session, presses no key, and resolves `ended` with its tasks once it is gone', async () => {
    await idleSession();
    hook('/turn-ended-with-a-task');
    const pid = host.pidOf(KEY);

    const result = ending();
    await settle();
    expect(signals).toEqual([`${pid} SIGTERM`]);
    await exits();

    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('signals at once a session waiting in the terminal at a start-up dialog, no key pressed: `app`, never `declined`', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
    });
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    await expect(launched).resolves.toMatchObject({ state: 'waiting' });

    const result = ending();
    await settle();
    expect(signals).toHaveLength(1);
    await exits();

    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'app' });
    expect(sessions.session(KEY)).not.toHaveProperty('dialog');
  });

  it('has nothing to end for a key with no session: no state', async () => {
    await expect(sessions.interruptAndEnd(KEY, 'app')).resolves.toEqual({
      action: 'nothing-to-end',
    });
    expect(signals).toEqual([]);
  });

  it('has nothing to end on an ended session: its state', async () => {
    await idleSession();
    await exits();

    await expect(sessions.interruptAndEnd(KEY, 'app')).resolves.toEqual({
      action: 'nothing-to-end',
      state: 'ended',
    });
    expect(signals).toEqual([]);
  });

  it('is refused on a starting session, with its state: nothing pressed or signalled', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
    });
    launched.catch(() => {});
    await settle();

    const refusal = await sessions.interruptAndEnd(KEY, 'app').catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CockpitError);
    expect(refusal).toMatchObject({ code: 'wrong-state', key: KEY, state: 'starting' });
    expect(writes()).toEqual([]);
    expect(signals).toEqual([]);
  });
});

describe('an end of a session in a turn', () => {
  it("interrupts the turn first, the driver's keys pressed once, then signals the agent: the tasks it listed stopped", async () => {
    await busySession();

    const result = ending();
    await settle();
    expect(writes()).toEqual(['Escape']);
    expect(signals).toEqual([]);
    recorded({ type: 'interrupted' });
    await settle();
    expect(signals).toHaveLength(1);
    await exits();

    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
    expect(writes()).toEqual(['Escape']);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('signals the agent anyway when the interrupt is not confirmed within its bound, and stops the subagents the turn started', async () => {
    await busySession();
    recorded({ type: 'task-started', task: { id: 'b2', type: 'Explore' } });

    const result = ending();
    await vi.advanceTimersByTimeAsync(INTERRUPT_BOUND_MS - 1);
    expect(signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toHaveLength(1);
    await exits();

    await expect(result).resolves.toEqual({
      action: 'ended',
      stoppedTasks: [TASK, { id: 'b2', type: 'Explore' }],
    });
    expect(writes()).toEqual(['Escape']);
  });

  it('signals the agent anyway when the host fails as the keys are pressed', async () => {
    await busySession();
    host.sendKeys = async () => {
      throw new SessionHostError('host-failed', 'tmux failed.');
    };

    const result = ending();
    await settle();
    expect(signals).toHaveLength(1);
    await exits();

    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
  });

  it('clears a prompt the interrupt withdrew, then signals the agent', async () => {
    await busySession();

    const result = ending();
    await settle();
    host.show(KEY, withdrawnScreen(PROMPT));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    await settle();
    expect(writes()).toEqual(['Escape', 'C-u']);
    expect(signals).toHaveLength(1);
    await exits();

    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
  });

  it('resolves `ended`, `app`, with the tasks known as it went, when the agent exits by itself during the interrupt: nothing signalled', async () => {
    await busySession();

    const result = ending();
    await settle();
    hook('/agent-exit');
    await exits();

    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
    expect(signals).toEqual([]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it("rejects with the close's refusal when the core is closed during the interrupt: nothing signalled or killed", async () => {
    await busySession();
    const result = ending();
    await settle();

    sessions.close();

    await expect(result).rejects.toBeInstanceOf(SessionsClosedError);
    await vi.advanceTimersByTimeAsync(INTERRUPT_BOUND_MS + ENDING_BOUND_MS);
    expect(signals).toEqual([]);
    expect(host.kills).toEqual([]);
  });
});

describe('an end asked while another is under way', () => {
  it('waits for it, presses no key, signals nothing more, and gives the tasks it stopped: its reason kept', async () => {
    await busySession();
    const first = sessions.end(KEY, 'session-cap');
    first.catch(() => {});
    await settle();

    const result = ending();
    await settle();
    await exits();

    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [TASK] });
    expect(writes()).toEqual([]);
    expect(signals).toHaveLength(1);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'session-cap' });
  });
});

describe('an end whose kill fails', () => {
  it('rejects with the host, the session live and heard, its later going its own; a later end kills it', async () => {
    await idleSession();
    host.failNextKill(new SessionHostError('host-failed', 'tmux failed.'));

    const failed = ending();
    await vi.advanceTimersByTimeAsync(ENDING_BOUND_MS);
    await expect(failed).rejects.toThrow('tmux failed.');
    hook('/prompt-taken');
    expect(sessions.session(KEY)?.state).toBe('busy');

    const result = ending();
    await settle();
    recorded({ type: 'interrupted' });
    await vi.advanceTimersByTimeAsync(ENDING_BOUND_MS);
    await expect(result).resolves.toEqual({ action: 'ended', stoppedTasks: [] });
    expect(host.kills).toEqual([KEY]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('leaves no reason of its own behind: the agent exiting later ends for its own', async () => {
    await idleSession();
    host.failNextKill(new SessionHostError('host-failed', 'tmux failed.'));
    const failed = ending();
    await vi.advanceTimersByTimeAsync(ENDING_BOUND_MS);
    await expect(failed).rejects.toThrow('tmux failed.');

    hook('/agent-exit');
    await exits();

    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'agent-exit' });
  });
});
