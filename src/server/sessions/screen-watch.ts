import type { ScreenReading } from '../driver.js';

/**
 * How often a session's screen is read while no hook can tell what it
 * shows. Claude Code draws a start-up dialog 0.23–0.34 s after its launch,
 * and its first hook comes at about 0.33 s: read every quarter second, a
 * dialog reaches the app within half a second of the launch, and a start
 * with no dialog is read at most twice. One read is one call to tmux, a
 * few milliseconds. The same pace serves a prompt an early Esc withdrew:
 * the agent redraws it in the box 0.07–0.17 s after the Esc, so the session
 * is `idle` within about 0.4 s of it, far inside the driver's interrupt
 * bound.
 */
export const SCREEN_INTERVAL_MS = 250;

/** What a screen watch works with: what it reads of the screen, a driver's reading or its text. */
export interface ScreenWatchOptions<Read = ScreenReading> {
  /**
   * Reads what the screen shows now; `undefined` when it cannot be read
   * (the session is gone, the host failed, or a person scrolled it back),
   * which the watch skips.
   */
  readonly read: () => Promise<Read | undefined>;
  /** Called with each reading, in order. */
  readonly onReading: (reading: Read) => void;
}

/**
 * Reads a session's screen every {@link SCREEN_INTERVAL_MS}, one read at a
 * time, until stopped: a read that answers late delays the next, never
 * overlaps it.
 */
export class ScreenWatch<Read = ScreenReading> {
  readonly #options: ScreenWatchOptions<Read>;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  /** @param options - See {@link ScreenWatchOptions}. */
  constructor(options: ScreenWatchOptions<Read>) {
    this.#options = options;
  }

  /** Starts reading: the first read one interval from now. */
  start(): void {
    this.#schedule();
  }

  /** Starts reading: the first read at once. */
  startNow(): void {
    void this.#tick();
  }

  /** Stops reading: no reading is given from now on, even of a read under way. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#tick(), SCREEN_INTERVAL_MS);
  }

  async #tick(): Promise<void> {
    const reading = await this.#options.read();
    if (this.#stopped) return;
    if (reading !== undefined) this.#options.onReading(reading);
    this.#schedule();
  }
}
