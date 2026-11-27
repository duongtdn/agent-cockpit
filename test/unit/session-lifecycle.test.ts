import { describe, expect, it } from 'vitest';
import {
  LifecycleMoveError,
  type Phase,
  SessionLifecycle,
} from '../../src/server/sessions/session-lifecycle.ts';

/** A lifecycle moved through the phases given, from `reserved`. */
function movedThrough(...phases: Phase[]): SessionLifecycle {
  const lifecycle = new SessionLifecycle('reserved');
  for (const phase of phases) lifecycle.move(phase);
  return lifecycle;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("a session's lifecycle", () => {
  it('moves as the table allows: launched, live, asked to end, killed, gone, ended', () => {
    const lifecycle = movedThrough('launching', 'live', 'ending', 'killing', 'going', 'ended');

    expect(lifecycle.phase).toBe('ended');
  });

  it('refuses any other move: a programming error, the phase kept', () => {
    const lifecycle = movedThrough('launching', 'live', 'ending');

    expect(lifecycle.can('live')).toBe(false);
    expect(() => lifecycle.move('live')).toThrow(LifecycleMoveError);
    expect(lifecycle.phase).toBe('ending');
    expect(() => movedThrough('launching', 'live', 'going').move('killing')).toThrow(
      'cannot move from going to killing',
    );
  });

  it('leaves a kill that failed live: heard again, and an end may begin again', () => {
    const lifecycle = movedThrough('launching', 'live', 'ending', 'killing', 'live');

    expect(lifecycle.isListened).toBe(true);
    expect(lifecycle.isLive).toBe(true);
  });

  it('begins only in a phase the table names', () => {
    expect(() => new SessionLifecycle('live' as 'reserved')).toThrow(LifecycleMoveError);
  });

  it('tells from its phase what the core may do with the session', () => {
    const at = (...phases: Phase[]) => {
      const lifecycle = movedThrough(...phases);
      return [lifecycle.isOnHost, lifecycle.isListened, lifecycle.takesInput];
    };

    expect(at()).toEqual([false, false, false]);
    expect(at('launching')).toEqual([false, true, true]);
    expect(at('launching', 'live')).toEqual([true, true, true]);
    expect(at('launching', 'live', 'ending')).toEqual([true, true, false]);
    expect(at('launching', 'live', 'killing')).toEqual([true, false, false]);
    expect(at('launching', 'live', 'going')).toEqual([false, false, false]);
  });

  it('goes from the host once, every caller awaiting the same end, told once the session is `ended`', async () => {
    const lifecycle = movedThrough('launching', 'live');
    const told: Phase[] = [];
    let write = () => {};
    const written = new Promise<void>((resolve) => {
      write = resolve;
    });
    const going = async () => {
      await written;
      return () => void told.push(lifecycle.phase);
    };

    const first = lifecycle.go(going);
    const second = lifecycle.go(going);
    await settle();
    expect(lifecycle.phase).toBe('going');
    expect(told).toEqual([]);

    write();
    await Promise.all([first, second, lifecycle.ended]);
    expect(told).toEqual(['ended']);
    await expect(lifecycle.go(going)).resolves.toBeUndefined();
    expect(told).toEqual(['ended']);
  });

  it('has nothing to go from before the session is on the host', async () => {
    const lifecycle = movedThrough('launching');
    let gone = false;

    await lifecycle.go(async () => () => {
      gone = true;
    });

    expect(gone).toBe(false);
    expect(lifecycle.phase).toBe('launching');
  });
});
