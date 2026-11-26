import type { ScreenReading } from '../driver.js';

/**
 * How often a session's screen is read while no hook can tell what it
 * shows. Claude Code draws a start-up dialog 0.23–0.34 s after its launch,
 * and its first hook comes at about 0.33 s: read every quarter second, a
 * dialog reaches the app within half a second of the launch, and a start
 * with no dialog is read at most twice. One read is one call to tmux, a
 * few milliseconds.
 */
export const SCREEN_INTERVAL_MS = 250;

/** What a screen watch works with. */
export interface ScreenWatchOptions {
  /**
   * Reads what the screen shows now; `undefined` when it cannot be read
   * (the session is gone, the host failed, or a person scrolled it back),
   * which the watch skips.
   */
  readonly read: () => Promise<ScreenReading | undefined>;
  /** Called with each reading, in order. */
  readonly onReading: (reading: ScreenReading) => void;
}

/**
 * Reads a session's screen every {@link SCREEN_INTERVAL_MS}, one read at a
 * time, until stopped: a read that answers late delays the next, never
 * overlaps it.
 */
export class ScreenWatch {
  readonly #options: ScreenWatchOptions;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  /** @param options - See {@link ScreenWatchOptions}. */
  constructor(options: ScreenWatchOptions) {
    this.#options = options;
  }

  /** Starts reading: the first read one interval from now. */
  start(): void {
    this.#schedule();
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
