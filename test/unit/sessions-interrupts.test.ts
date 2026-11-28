import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import {
  createSessions,
  LIVENESS_INTERVAL_MS,
  SCREEN_INTERVAL_MS,
  type Sessions,
  SessionsClosedError,
} from '../../src/server/sessions/sessions.ts';
import { interruptionOf } from '../../src/server/sessions/turn-interrupt.ts';
import { createTerminalHolds, type TerminalHolds } from '../../src/server/terminal-hold.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import type { InterruptResult, Session } from '../../src/shared/session.ts';
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

let host: FakeHost;
let driver: StubDriver;
let holds: TerminalHolds;
let sessions: Sessions;
/** The terminal of the page joined to the key's holds: what it was told. */
let pageTerminal: string[];
/** Every list the core's followers were told, the key's session in each. */
let told: (Session | undefined)[];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  host = createFakeHost();
  driver = createStubDriver();
  holds = createTerminalHolds();
  pageTerminal = [];
  told = [];
  holds.join(KEY, {
    hold: () => void pageTerminal.push('held'),
    release: () => void pageTerminal.push('released'),
    discard: () => void pageTerminal.push('discarded'),
  });
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
    holds,
    // An agent signalled stays until the test makes it go.
    signal: () => {},
  });
  sessions.follow((list) => void told.push(list.find((session) => session.key === KEY)));
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
const nextRead = () => vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
const { boundMs: INTERRUPT_BOUND_MS } = createStubDriver().interrupting;

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

/** Brings a session to `busy` on a prompt the agent took, its text carried. */
async function busySession(prompt = PROMPT): Promise<void> {
  await idleSession();
  hook(`${PROMPT_PATH}${prompt}`);
  host.show(KEY, 'the agent at work');
}

/** Interrupts the key's session, the outcome kept for the test to look at. */
function interrupting(): Promise<InterruptResult> {
  const result = sessions.interrupt(KEY);
  result.catch(() => {});
  return result;
}

/** A promise whose outcome the test can look at before it awaits it. */
function watched<T>(promise: Promise<T>): { readonly outcome: 'pending' | 'settled' } {
  let outcome: 'pending' | 'settled' = 'pending';
  const settled = () => {
    outcome = 'settled';
  };
  promise.then(settled, settled);
  return {
    get outcome() {
      return outcome;
    },
  };
}

/** The writes into the key's session, without its name. */
function writes(): string[] {
  return host.writes.map((write) => write.slice(KEY.length + 1));
}

describe('what an interrupt does, by what the session is', () => {
  const at = '2026-11-28T10:00:00.000Z';
  const waiting = (pending: Extract<Session, { state: 'waiting' }>['pending']): Session => ({
    key: KEY,
    state: 'waiting',
    since: at,
    pending,
  });

  it.each<[string, Session | undefined, ReturnType<typeof interruptionOf>]>([
    ['no session', undefined, 'nothing'],
    ['idle', { key: KEY, state: 'idle', since: at }, 'nothing'],
    [
      'ended',
      { key: KEY, state: 'ended', since: at, canResume: true, reason: 'agent-exit' },
      'nothing',
    ],
    ['starting', { key: KEY, state: 'starting', since: at }, 'refused'],
    ['busy', { key: KEY, state: 'busy', since: at }, 'stop-the-turn'],
    [
      'waiting in the terminal at a start-up dialog',
      waiting([{ kind: 'terminal', dialog: 'trust-folder' }]),
      'nothing',
    ],
    ['waiting in the terminal at a screen of no name', waiting([{ kind: 'terminal' }]), 'nothing'],
    ['waiting on an ask', waiting([{ kind: 'ask', id: 'q1' }]), 'stop-the-turn'],
    ['waiting on a channel request', waiting([{ kind: 'request', id: 'r1' }]), 'stop-the-turn'],
    [
      'waiting on an ask shown in the terminal',
      waiting([{ kind: 'terminal', id: 'q1' }]),
      'stop-the-turn',
    ],
    [
      'waiting in the terminal and on an ask',
      waiting([{ kind: 'terminal' }, { kind: 'ask', id: 'q1' }]),
      'stop-the-turn',
    ],
  ])('%s: %s', (_, session, expected) => {
    expect(interruptionOf(session)).toBe(expected);
  });
});

describe('an interrupt with no turn to stop', () => {
  it('resolves at once for a key with no session, with no state, and sends no key', async () => {
    await expect(sessions.interrupt(KEY)).resolves.toEqual({ action: 'nothing-to-interrupt' });
    expect(writes()).toEqual([]);
  });

  it('resolves at once on an idle session, with its state, and sends no key', async () => {
    await idleSession();

    await expect(sessions.interrupt(KEY)).resolves.toEqual({
      action: 'nothing-to-interrupt',
      state: 'idle',
    });
    expect(writes()).toEqual([]);
  });

  it('resolves at once on an ended session, with its state, and sends no key', async () => {
    await idleSession();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(sessions.interrupt(KEY)).resolves.toEqual({
      action: 'nothing-to-interrupt',
      state: 'ended',
    });
    expect(writes()).toEqual([]);
  });

  it('resolves at once on a session waiting in the terminal at a start-up dialog, and sends no key', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
    });
    host.show(KEY, stubScreen('trust-folder'));
    await nextRead();
    await launched;

    await expect(sessions.interrupt(KEY)).resolves.toEqual({
      action: 'nothing-to-interrupt',
      state: 'waiting',
    });
    expect(writes()).toEqual([]);
  });

  it('is refused on a starting session, with its state, and sends no key', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
    });
    launched.catch(() => {});
    await settle();

    const refusal = await sessions.interrupt(KEY).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CockpitError);
    expect(refusal).toMatchObject({ code: 'wrong-state', key: KEY, state: 'starting' });
    expect(writes()).toEqual([]);
  });

  it('waits for an end under way, then finds the session ended, and sends no key', async () => {
    await idleSession();
    const ended = sessions.end(KEY, 'session-cap');
    ended.catch(() => {});
    await settle();

    const result = interrupting();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(result).resolves.toEqual({ action: 'nothing-to-interrupt', state: 'ended' });
    expect(writes()).toEqual([]);
  });
});

describe('an interrupt of a busy session', () => {
  it("presses the driver's keys once, and resolves `interrupted` once the transcript records the interruption", async () => {
    await busySession();

    const result = interrupting();
    await settle();
    expect(writes()).toEqual(['Escape']);
    recorded({ type: 'interrupted' });

    await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    expect(sessions.session(KEY)).toMatchObject({ state: 'idle' });
    expect(writes()).toEqual(['Escape']);
  });

  it('resolves `interrupted` when the turn ends as the key is pressed; a turn the agent begins after is not touched', async () => {
    await busySession();

    const result = interrupting();
    await settle();
    hook('/turn-ended');
    await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });

    hook('/prompt-taken');
    await vi.advanceTimersByTimeAsync(INTERRUPT_BOUND_MS);
    expect(sessions.session(KEY)).toMatchObject({ state: 'busy' });
    expect(writes()).toEqual(['Escape']);
  });

  it('fails `interrupt-unconfirmed` with the key and the last state when the session is not idle within the bound, never pressing a key again', async () => {
    await busySession();

    const result = interrupting();
    const outcome = watched(result);
    await vi.advanceTimersByTimeAsync(INTERRUPT_BOUND_MS - 1);
    expect(outcome.outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);

    const refusal = await result.catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CockpitError);
    expect(refusal).toMatchObject({ code: 'interrupt-unconfirmed', key: KEY, state: 'busy' });
    expect(writes()).toEqual(['Escape']);
  });

  it('leaves the session as it is after an unconfirmed interrupt: a later interruption makes it idle, with no key', async () => {
    await busySession();
    const result = interrupting();
    await vi.advanceTimersByTimeAsync(INTERRUPT_BOUND_MS);
    await expect(result).rejects.toMatchObject({ code: 'interrupt-unconfirmed' });

    recorded({ type: 'interrupted' });

    expect(sessions.session(KEY)).toMatchObject({ state: 'idle' });
    expect(writes()).toEqual(['Escape']);
  });

  it('resolves `nothing-to-interrupt` with the ended state when the agent goes meanwhile, before the bound', async () => {
    await busySession();
    const result = interrupting();
    await settle();

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(result).resolves.toEqual({ action: 'nothing-to-interrupt', state: 'ended' });
    expect(writes()).toEqual(['Escape']);
  });

  it('resolves `nothing-to-interrupt` with the ended state, at once, when the session is gone as the key is pressed', async () => {
    await busySession();
    host.exit(KEY);

    await expect(sessions.interrupt(KEY)).resolves.toEqual({
      action: 'nothing-to-interrupt',
      state: 'ended',
    });
  });

  it('rejects with what the host fails with when it cannot press the key', async () => {
    await busySession();
    const failure = new SessionHostError('host-failed', 'tmux failed.');
    host.sendKeys = async () => {
      throw failure;
    };

    await expect(sessions.interrupt(KEY)).rejects.toBe(failure);
  });

  it("rejects with the close's refusal when the core is closed during the wait, and sends nothing more", async () => {
    await busySession();
    const result = interrupting();
    await settle();

    sessions.close();

    await expect(result).rejects.toBeInstanceOf(SessionsClosedError);
    expect(writes()).toEqual(['Escape']);
  });

  it("is refused with the close's refusal once the core is closed", async () => {
    await busySession();
    sessions.close();

    await expect(sessions.interrupt(KEY)).rejects.toBeInstanceOf(SessionsClosedError);
    expect(writes()).toEqual([]);
  });

  it('stops a compaction begun idle, confirmed by its caveat: back to idle, with no screen read for a prompt', async () => {
    await idleSession();
    hook('/compaction-began');
    const reads = host.screenReads;

    const result = interrupting();
    await settle();
    recorded({ type: 'command-done', entry: 'caveat' });

    await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    expect(writes()).toEqual(['Escape']);
    expect(host.screenReads).toBe(reads);
  });

  it('leaves the background tasks going: the idle session lists those it listed before', async () => {
    await idleSession();
    hook('/turn-ended-with-a-task');
    hook(`${PROMPT_PATH}${PROMPT}`);

    const result = interrupting();
    await settle();
    recorded({ type: 'interrupted' });

    await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    expect(sessions.session(KEY)).toMatchObject({
      state: 'idle',
      backgroundTasks: [{ id: 'a1', type: 'general-purpose' }],
    });
  });
});

describe('the prompt withdrawn by an early Esc, read on screen', () => {
  it('makes a busy session idle once the box holds the prompt, read every screen interval; nothing is cleared', async () => {
    await busySession();
    host.show(KEY, withdrawnScreen(PROMPT));

    await nextRead();

    expect(sessions.session(KEY)).toEqual({ key: KEY, state: 'idle', since: expect.any(String) });
    expect(writes()).toEqual([]);
  });

  it('lists again the background tasks the session listed before the turn', async () => {
    await idleSession();
    hook('/turn-ended-with-a-task');
    hook(`${PROMPT_PATH}${PROMPT}`);
    host.show(KEY, withdrawnScreen(PROMPT));

    await nextRead();

    expect(sessions.session(KEY)).toMatchObject({
      state: 'idle',
      backgroundTasks: [{ id: 'a1', type: 'general-purpose' }],
    });
  });

  it('is not read on a box holding another text', async () => {
    await busySession();
    host.show(KEY, withdrawnScreen('Another prompt.'));

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);

    expect(sessions.session(KEY)).toMatchObject({ state: 'busy' });
  });

  it('is not read for a turn whose prompt the agent gave no text of: no screen is read', async () => {
    await idleSession();
    hook('/prompt-taken');
    host.show(KEY, withdrawnScreen(''));
    const reads = host.screenReads;

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);

    expect(sessions.session(KEY)).toMatchObject({ state: 'busy' });
    expect(host.screenReads).toBe(reads);
  });

  it('is not read before a prompt was taken: an idle box holding the same text changes nothing', async () => {
    await idleSession();
    host.show(KEY, withdrawnScreen(PROMPT));
    const reads = host.screenReads;

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);

    expect(sessions.session(KEY)).toMatchObject({ state: 'idle' });
    expect(host.screenReads).toBe(reads);
  });

  it('is read no more once a hook of the turn came: the hook tells', async () => {
    await busySession();
    hook('/working');
    const reads = host.screenReads;
    host.show(KEY, withdrawnScreen(PROMPT));

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);

    expect(sessions.session(KEY)).toMatchObject({ state: 'busy' });
    expect(host.screenReads).toBe(reads);
  });

  it('is read no more once the turn ended', async () => {
    await busySession();
    hook('/turn-ended');
    const reads = host.screenReads;

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);

    expect(host.screenReads).toBe(reads);
  });

  it('is read no more once the session ended', async () => {
    await busySession();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    const reads = host.screenReads;

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);

    expect(sessions.session(KEY)).toMatchObject({ state: 'ended' });
    expect(host.screenReads).toBe(reads);
  });

  it('is read no more once the core is closed', async () => {
    await busySession();
    sessions.close();
    const reads = host.screenReads;
    host.show(KEY, withdrawnScreen(PROMPT));

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);

    expect(host.screenReads).toBe(reads);
    expect(sessions.session(KEY)).toMatchObject({ state: 'busy' });
  });

  it("reads nothing of a screen a person scrolled back, and reads it once it is the agent's again", async () => {
    await busySession();
    host.show(KEY, withdrawnScreen(PROMPT));
    host.scrollBack(KEY, true);

    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS * 4);
    expect(sessions.session(KEY)).toMatchObject({ state: 'busy' });

    host.scrollBack(KEY, false);
    await nextRead();
    expect(sessions.session(KEY)).toMatchObject({ state: 'idle' });
  });

  it('is read for the later prompt when the agent takes another', async () => {
    await busySession();
    hook(`${PROMPT_PATH}And the docs.`);
    host.show(KEY, withdrawnScreen('And the docs.'));

    await nextRead();

    expect(sessions.session(KEY)).toMatchObject({ state: 'idle' });
  });

  it('is read past an interruption the transcript recorded before the prompt was taken', async () => {
    await busySession();
    recorded({ type: 'interrupted', at: '2026-11-28T09:59:59.000Z' });
    host.show(KEY, withdrawnScreen(PROMPT));

    await nextRead();

    expect(sessions.session(KEY)).toMatchObject({ state: 'idle' });
  });
});

describe('an interrupt confirmed by the withdrawn prompt', () => {
  it('resolves `interrupted` and clears the box, the page’s terminal keys held meanwhile', async () => {
    await busySession();

    const result = interrupting();
    await settle();
    host.show(KEY, withdrawnScreen(PROMPT));
    await nextRead();

    await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    expect(writes()).toEqual(['Escape', 'C-u']);
    expect(pageTerminal).toEqual(['held', 'released']);
  });

  it('tells the idle session before the box is cleared', async () => {
    await busySession();
    let seenAsTheClearingBegan: Session | undefined;
    const clear = driver.clearInputBox;
    driver.clearInputBox = async (terminal) => {
      seenAsTheClearingBegan = told.at(-1);
      return clear(terminal);
    };

    const result = interrupting();
    await settle();
    host.show(KEY, withdrawnScreen(PROMPT));
    await nextRead();
    await result;

    expect(seenAsTheClearingBegan).toMatchObject({ state: 'idle' });
  });

  it.each(['not-emptied', 'no-input-box'] as const)(
    'resolves `interrupted` when the clearing reports %s: the turn stopped',
    async (clearing) => {
      await busySession();
      driver.clearInputBox = async () => clearing;

      const result = interrupting();
      await settle();
      host.show(KEY, withdrawnScreen(PROMPT));
      await nextRead();

      await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    },
  );

  it('resolves `interrupted` when the host fails during the clearing: the turn stopped', async () => {
    await busySession();
    driver.clearInputBox = async () => {
      throw new SessionHostError('host-failed', 'tmux failed.');
    };

    const result = interrupting();
    await settle();
    host.show(KEY, withdrawnScreen(PROMPT));
    await nextRead();

    await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });
  });

  it("rejects with the close's refusal when the core is closed during the clearing", async () => {
    await busySession();
    driver.clearInputBox = async () => {
      sessions.close();
      return 'cleared';
    };

    const result = interrupting();
    await settle();
    host.show(KEY, withdrawnScreen(PROMPT));
    await nextRead();

    await expect(result).rejects.toBeInstanceOf(SessionsClosedError);
  });

  it('clears nothing when the session moved on from the withdrawn idle before the interrupt looked', async () => {
    await busySession();
    const result = interrupting();
    await settle();
    host.show(KEY, withdrawnScreen(PROMPT));
    const followed = sessions.follow((list) => {
      if (list.some((session) => session.key === KEY && session.state === 'idle')) {
        hook('/prompt-taken');
      }
    });

    await nextRead();
    followed();

    await expect(result).resolves.toEqual({ action: 'interrupted', state: 'idle' });
    expect(writes()).toEqual(['Escape']);
  });

  it('clears nothing when the interruption was recorded: the box holds the person’s draft or nothing', async () => {
    await busySession();

    const result = interrupting();
    await settle();
    recorded({ type: 'interrupted' });
    await result;

    expect(writes()).toEqual(['Escape']);
    expect(pageTerminal).toEqual([]);
  });

  it('makes one idle, told once, when the screen and the transcript both tell it', async () => {
    await busySession();
    const result = interrupting();
    await settle();
    host.show(KEY, withdrawnScreen(PROMPT));
    const before = told.length;

    await nextRead();
    recorded({ type: 'interrupted' });
    await result;

    expect(told.slice(before).map((session) => session?.state)).toEqual(['idle']);
  });
});
