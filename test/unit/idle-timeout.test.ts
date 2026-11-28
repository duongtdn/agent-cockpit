import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIdleTimeout,
  type IdleTimeout,
  type TimerHandle,
  type Timers,
  type TryEnd,
} from '../../src/server/sessions/idle-timeout.ts';
import type { Session } from '../../src/shared/session.ts';

const T0 = new Date('2026-11-28T10:00:00.000Z');
const TIMEOUT_MS = 30 * 60_000;
const KEY = 'explain-readme';

type Outcome = Awaited<ReturnType<TryEnd>>;

let tries: string[];
let outcomes: (() => Promise<Outcome>)[];
let reported: unknown[];
let idleTimeout: IdleTimeout;

/** The time `ms` after T0, as a session's `since`. */
const at = (ms: number): string => new Date(T0.getTime() + ms).toISOString();

const idle = (since: string, key = KEY): Session => ({ key, state: 'idle', since });
const busy = (since: string, key = KEY): Session => ({ key, state: 'busy', since });
const ended = (since: string, key = KEY): Session => ({
  key,
  state: 'ended',
  since,
  canResume: true,
  reason: 'idle-timeout',
});

/** The core's answers to the next tries, in order; `'ended'` once they run out. */
function answer(...next: (Outcome | Error | Promise<Outcome>)[]): void {
  outcomes.push(
    ...next.map(
      (outcome) => () =>
        outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
    ),
  );
}

function build(timers?: Timers): IdleTimeout {
  return createIdleTimeout({
    timeoutMs: TIMEOUT_MS,
    tryEnd: (key) => {
      tries.push(key);
      return outcomes.shift()?.() ?? Promise.resolve('ended');
    },
    report: (thrown) => reported.push(thrown),
    ...(timers === undefined ? {} : { timers }),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  tries = [];
  outcomes = [];
  reported = [];
  idleTimeout = build();
});

afterEach(() => {
  idleTimeout.close();
  vi.useRealTimers();
});

describe('an idle session', () => {
  it('is tried once its timeout has passed since it became idle, not before', async () => {
    idleTimeout.observe(idle(at(0)));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(tries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toEqual([KEY]);
  });

  it('counts from its `since`, not from when it is observed', async () => {
    vi.setSystemTime(T0.getTime() + 10 * 60_000);
    idleTimeout.observe(idle(at(0)));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 10 * 60_000 - 1);
    expect(tries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toEqual([KEY]);
  });

  it('is tried at once when its timeout has passed already', async () => {
    vi.setSystemTime(T0.getTime() + 2 * TIMEOUT_MS);
    idleTimeout.observe(idle(at(0)));

    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toEqual([KEY]);
  });

  it('keeps its timer when observed again idle since the same time', async () => {
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    idleTimeout.observe(idle(at(0)));

    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toEqual([KEY]);
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT_MS);
    expect(tries).toEqual([KEY]);
  });

  it('is tried from its new `since` when it went busy, then idle again', async () => {
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    idleTimeout.observe(busy(at(20 * 60_000)));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    idleTimeout.observe(idle(at(25 * 60_000)));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(tries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toEqual([KEY]);
  });

  it('is tried from its new `since` when observed idle since a later time', async () => {
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    idleTimeout.observe(idle(at(10 * 60_000)));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(tries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toEqual([KEY]);
  });

  it('keeps a timer of its own for each key', async () => {
    idleTimeout.observe(idle(at(0), 'unit-a'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    idleTimeout.observe(idle(at(10 * 60_000), 'unit-b'));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 10 * 60_000);
    expect(tries).toEqual(['unit-a']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tries).toEqual(['unit-a', 'unit-b']);
  });
});

describe('a session in any other state', () => {
  it.each([
    ['busy', busy],
    ['ended', ended],
  ])('is not tried once %s', async (_state, session) => {
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(60_000);
    idleTimeout.observe(session(at(60_000)));

    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toEqual([]);
  });

  it.each([
    ['starting', { key: KEY, state: 'starting', since: at(0) }],
    [
      'waiting',
      { key: KEY, state: 'waiting', since: at(0), pending: [{ kind: 'ask', id: 'ask-1' }] },
    ],
  ] as const)('is never tried while %s', async (_state, session) => {
    idleTimeout.observe(session as Session);

    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toEqual([]);
  });
});

describe('a try', () => {
  it('that finds the session held tries again one full timeout later, until it ends', async () => {
    answer('held', 'held', 'ended');
    idleTimeout.observe(idle(at(0)));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(tries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(tries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(tries).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toHaveLength(3);
  });

  it('counts the next timeout from when a held answer came back, not from when it was asked', async () => {
    let release: (outcome: Outcome) => void = () => {};
    answer(new Promise<Outcome>((resolve) => (release = resolve)));
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(5_000);

    release('held');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(tries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toHaveLength(2);
  });

  it('that finds the session no longer idle tries nothing more until it is observed idle again', async () => {
    answer('not-idle');
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(tries).toEqual([KEY]);

    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toEqual([KEY]);

    idleTimeout.observe(busy(at(4 * TIMEOUT_MS)));
    idleTimeout.observe(idle(at(4 * TIMEOUT_MS)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(tries).toEqual([KEY, KEY]);
  });

  it('that rejects is reported, and tried again one full timeout later', async () => {
    const failure = new Error('the host is gone');
    answer(failure, 'ended');
    idleTimeout.observe(idle(at(0)));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(reported).toEqual([failure]);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(tries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toHaveLength(2);
  });

  it('that rejects goes to the console when no report is given', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('the host is gone');
    const quiet = createIdleTimeout({
      timeoutMs: TIMEOUT_MS,
      tryEnd: () => Promise.reject(failure),
    });
    try {
      quiet.observe(idle(at(0)));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(error).toHaveBeenCalledWith(failure);
    } finally {
      quiet.close();
      error.mockRestore();
    }
  });

  it('that finds the session held while it went busy does not try again', async () => {
    let release: (outcome: Outcome) => void = () => {};
    answer(new Promise<Outcome>((resolve) => (release = resolve)));
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    idleTimeout.observe(busy(at(TIMEOUT_MS)));

    release('held');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toHaveLength(1);
  });

  it('that finds the session held while it became idle anew leaves the new count alone', async () => {
    let release: (outcome: Outcome) => void = () => {};
    answer(new Promise<Outcome>((resolve) => (release = resolve)));
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    idleTimeout.observe(idle(at(TIMEOUT_MS)));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    release('held');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 10 * 60_000);
    expect(tries).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tries).toHaveLength(2);
  });

  it('is not made again while one is under way and the session is observed idle since the same time', async () => {
    let release: (outcome: Outcome) => void = () => {};
    answer(new Promise<Outcome>((resolve) => (release = resolve)), 'ended');
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toHaveLength(1);

    release('held');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(tries).toHaveLength(2);
  });
});

describe('forget', () => {
  it("clears a key's timer and leaves the others", async () => {
    idleTimeout.observe(idle(at(0), 'unit-a'));
    idleTimeout.observe(idle(at(0), 'unit-b'));
    idleTimeout.forget('unit-a');

    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toEqual(['unit-b']);
  });

  it('keeps a try under way that comes back held from trying again', async () => {
    let release: (outcome: Outcome) => void = () => {};
    answer(new Promise<Outcome>((resolve) => (release = resolve)));
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    idleTimeout.forget(KEY);

    release('held');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toHaveLength(1);
  });
});

describe('close', () => {
  it('clears every timer', async () => {
    idleTimeout.observe(idle(at(0), 'unit-a'));
    idleTimeout.observe(idle(at(0), 'unit-b'));
    idleTimeout.close();

    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves later observations unarmed', async () => {
    idleTimeout.close();
    idleTimeout.observe(idle(at(0)));

    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toEqual([]);
  });

  it('keeps a try under way that comes back held from trying again', async () => {
    let release: (outcome: Outcome) => void = () => {};
    answer(new Promise<Outcome>((resolve) => (release = resolve)));
    idleTimeout.observe(idle(at(0)));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    idleTimeout.close();

    release('held');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MS);
    expect(tries).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the timers', () => {
  /** Timers that fire by hand, each handle with an `unref` that counts its calls, or none. */
  function handTimers(withUnref: boolean) {
    const handles: (TimerHandle & { unrefs: number })[] = [];
    const callbacks = new Map<TimerHandle, () => void>();
    const timers: Timers = {
      now: () => T0.getTime(),
      setTimeout: (callback) => {
        const handle: TimerHandle & { unrefs: number } = { unrefs: 0 };
        if (withUnref) handle.unref = () => void handle.unrefs++;
        handles.push(handle);
        callbacks.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle) => void callbacks.delete(handle),
    };
    const fire = (handle: TimerHandle) => callbacks.get(handle)?.();
    return { handles, timers, fire };
  }

  it('unrefs every timer it sets, so that none holds the process open', async () => {
    const { handles, timers, fire } = handTimers(true);
    answer('held');
    const watched = build(timers);
    watched.observe(idle(at(0)));
    const [first] = handles;
    if (first === undefined) throw new Error('no timer was set');
    fire(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(handles).toHaveLength(2);

    expect(handles.map((handle) => handle.unrefs)).toEqual([1, 1]);
    watched.close();
  });

  it('takes a timer that has no `unref`', () => {
    const { handles, timers } = handTimers(false);
    const watched = build(timers);

    expect(() => watched.observe(idle(at(0)))).not.toThrow();
    expect(handles).toHaveLength(1);
    watched.close();
  });
});
