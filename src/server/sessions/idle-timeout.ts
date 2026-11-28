import type { Session } from '../../shared/session.js';

/** A timer as {@link Timers} sets it: unref'd when it can be. */
export interface TimerHandle {
  /** Lets the process exit while the timer is set, when the timer has it. */
  unref?(): unknown;
}

/** The clock and the timers an idle timeout runs on: the process's, unless a test gives its own. */
export interface Timers {
  /** The time now, in milliseconds since the epoch. */
  now(): number;
  /** Calls `callback` once, `ms` milliseconds from now. */
  setTimeout(callback: () => void, ms: number): TimerHandle;
  /** Clears a timer that {@link Timers.setTimeout} set. */
  clearTimeout(handle: TimerHandle): void;
}

/**
 * The core's attempt to end a session for `reason: 'idle-timeout'`, checking
 * and ending in one step. It answers `'ended'`, or `'held'` when background
 * tasks run, a terminal is attached or an operation of the app on the key is
 * under way, or `'not-idle'` when the session is no longer `idle`.
 */
export type TryEnd = (key: string) => Promise<'ended' | 'held' | 'not-idle'>;

/** What an idle timeout is built with. */
export interface IdleTimeoutOptions {
  /**
   * How long a session stays `idle` before it is tried, in milliseconds: an
   * integer from 1 to 2,147,483,647, the longest a timer waits.
   */
  readonly timeoutMs: number;
  /** Ends a session, or says why not: see {@link TryEnd}. */
  readonly tryEnd: TryEnd;
  /** The clock and timers: the process's, by default. */
  readonly timers?: Timers;
  /** Receives what a rejected {@link TryEnd} gave: the console, by default. */
  readonly report?: (thrown: unknown) => void;
}

/**
 * Decides when an `idle` session is tried for its end: once the timeout has
 * passed since it became `idle`, and again one full timeout after each try
 * that found it held. The ending, and whatever holds a
 * session, are the core's, behind {@link TryEnd}.
 */
export interface IdleTimeout {
  /**
   * Takes a session's update: an `idle` session is timed from its `since`,
   * kept as it is when timed from that `since` already; any other state
   * clears its timer.
   */
  observe(session: Session): void;
  /** Clears a key's timer: its session is gone. */
  forget(key: string): void;
  /** Clears every timer; nothing is timed afterwards. */
  close(): void;
}

/**
 * Builds an idle timeout. Every timer it sets is unref'd, so that none holds
 * the process open.
 *
 * @param options - See {@link IdleTimeoutOptions}.
 * @returns The idle timeout, timing nothing yet.
 * @throws RangeError when `timeoutMs` is not an integer a timer can wait:
 *   the cockpit's options refuse such a value before it gets here.
 */
export function createIdleTimeout(options: IdleTimeoutOptions): IdleTimeout {
  if (!isTimerDelay(options.timeoutMs)) {
    throw new RangeError(
      `timeoutMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}: ${options.timeoutMs}`,
    );
  }
  return new IdleTimers(options);
}

/** The longest a timer waits: Node fires a longer one after 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function isTimerDelay(ms: number): boolean {
  return Number.isInteger(ms) && ms >= 1 && ms <= MAX_TIMER_DELAY_MS;
}

/** Resolved at each call, so that a clock a test installs is the one used. */
const processTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * One `idle` of one session, timed: a new `idle` is a new watch, so that a
 * try made for an earlier one cannot time it.
 */
interface Watch {
  readonly since: string;
  /** Absent while a try is under way. */
  timer?: TimerHandle;
}

class IdleTimers implements IdleTimeout {
  readonly #timeoutMs: number;
  readonly #tryEnd: TryEnd;
  readonly #timers: Timers;
  readonly #report: (thrown: unknown) => void;
  readonly #watches = new Map<string, Watch>();
  #closed = false;

  constructor(options: IdleTimeoutOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#tryEnd = options.tryEnd;
    this.#timers = options.timers ?? processTimers;
    this.#report = options.report ?? ((thrown) => console.error(thrown));
  }

  observe(session: Session): void {
    if (this.#closed) return;
    if (session.state !== 'idle') {
      this.forget(session.key);
      return;
    }
    if (this.#watches.get(session.key)?.since === session.since) return;
    this.forget(session.key);
    const watch: Watch = { since: session.since };
    this.#watches.set(session.key, watch);
    this.#arm(session.key, watch, this.#untilDue(session.since));
  }

  forget(key: string): void {
    const watch = this.#watches.get(key);
    if (watch?.timer !== undefined) this.#timers.clearTimeout(watch.timer);
    this.#watches.delete(key);
  }

  close(): void {
    this.#closed = true;
    for (const key of [...this.#watches.keys()]) this.forget(key);
  }

  /**
   * The time left until `since` plus the timeout, never more than the
   * timeout: a clock set back, or a `since` that is not a time, waits one
   * timeout, not longer.
   */
  #untilDue(since: string): number {
    const left = Date.parse(since) + this.#timeoutMs - this.#timers.now();
    return Number.isNaN(left) ? this.#timeoutMs : Math.min(this.#timeoutMs, Math.max(0, left));
  }

  #arm(key: string, watch: Watch, ms: number): void {
    watch.timer = this.#timers.setTimeout(() => void this.#fire(key, watch), ms);
    watch.timer.unref?.();
  }

  async #fire(key: string, watch: Watch): Promise<void> {
    delete watch.timer;
    const tryAgain = await this.#tryOnce(key);
    // An update, a forget or a close while the try was out decided already.
    // Ended or no longer idle, the session's next update clears or re-times it.
    if (tryAgain && this.#watches.get(key) === watch) this.#arm(key, watch, this.#timeoutMs);
  }

  /** Whether the session must be tried again: it was held, or the try failed. */
  async #tryOnce(key: string): Promise<boolean> {
    try {
      return (await this.#tryEnd(key)) === 'held';
    } catch (thrown) {
      this.#reportSafely(thrown);
      return true;
    }
  }

  /** A report that throws goes to the console, not to an unhandled rejection that would end the process. */
  #reportSafely(thrown: unknown): void {
    try {
      this.#report(thrown);
    } catch (reportFailure) {
      console.error(thrown);
      console.error(reportFailure);
    }
  }
}
