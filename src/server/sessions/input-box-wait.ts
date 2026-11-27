import type { ScreenReading } from '../driver.js';
import { ScreenWatch } from './screen-watch.js';
import { type DialogShown, dialogShown } from './start-up-watch.js';

/**
 * How long after its first hook an agent has to draw its input box before
 * a first prompt is typed regardless (and refused, with no box to take
 * it). Claude Code sends `SessionStart` while its screen is still blank
 * and draws the box 34–48 ms later; the slowest start seen on a loaded
 * machine was five times the usual one. Five seconds leaves a hundred
 * times the gap, and is paid only by a start that never draws the box.
 * The wait starts again when a dialog leaves the screen, since a person
 * may answer it at any time.
 */
export const INPUT_BOX_BOUND_MS = 5_000;

/** What an input-box wait works with. */
export interface InputBoxWaitOptions {
  /** Reads what the screen shows now; `undefined` when it cannot be read. */
  readonly read: () => Promise<ScreenReading | undefined>;
  /** Called at each reading of a dialog: the session waits for a person in the terminal. */
  readonly onDialog: (shown: DialogShown) => void;
}

/**
 * Waits, reading the screen, for an agent that has started to draw its
 * input box: a dialog suspends the bound while it shows, anything else
 * leaves it at {@link INPUT_BOX_BOUND_MS}.
 */
export class InputBoxWait {
  readonly #options: InputBoxWaitOptions;
  readonly #screen: ScreenWatch;
  readonly #shown: Promise<boolean>;
  #settle: (shown: boolean) => void = () => {};
  #bound: NodeJS.Timeout | undefined;

  /** @param options - See {@link InputBoxWaitOptions}. */
  constructor(options: InputBoxWaitOptions) {
    this.#options = options;
    this.#shown = new Promise((resolve) => {
      this.#settle = resolve;
    });
    this.#screen = new ScreenWatch({
      read: options.read,
      onReading: (reading) => this.#take(reading),
    });
  }

  /**
   * Starts reading the screen, at once, with the bound from now.
   *
   * @returns Whether the input box showed: `false` once the bound passed
   * with no dialog on screen, or the wait was stopped.
   */
  start(): Promise<boolean> {
    this.#arm();
    this.#screen.startNow();
    return this.#shown;
  }

  /** Stops waiting: the wait settles as not shown, if it had not settled. */
  stop(): void {
    this.#end(false);
  }

  #take(reading: ScreenReading): void {
    switch (reading.shows) {
      case 'input-box':
        this.#end(true);
        return;
      case 'dialog':
      case 'panel':
        clearTimeout(this.#bound);
        this.#bound = undefined;
        this.#options.onDialog(dialogShown(reading));
        return;
      case 'unknown':
      case 'nothing':
        // A redraw between two screens keeps the bound it had.
        if (this.#bound === undefined) this.#arm();
        return;
    }
  }

  #arm(): void {
    clearTimeout(this.#bound);
    this.#bound = setTimeout(() => this.#end(false), INPUT_BOX_BOUND_MS);
  }

  #end(shown: boolean): void {
    this.#screen.stop();
    clearTimeout(this.#bound);
    this.#bound = undefined;
    this.#settle(shown);
  }
}
