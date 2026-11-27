import type { StartupDialog } from '../../shared/session.js';
import type { ScreenReading } from '../driver.js';
import { ScreenWatch } from './screen-watch.js';

/**
 * How long a launched agent may show neither a hook, nor a dialog, nor its
 * input box before the cockpit ends it as one it cannot observe: a
 * session whose state no hook tells is never left running. Claude Code draws one or the other within 0.45 s of its
 * launch, and the slowest start seen on a loaded machine took 2.2 s: this
 * leaves more than four times that. The wait starts again when a dialog
 * leaves the screen, since a person may answer it at any time.
 */
export const START_DEADLINE_MS = 10_000;

/**
 * How long after its input box first shows a launched agent has to send
 * its first hook. Claude Code's `SessionStart` comes about 0.1 s before the
 * box (0.32–0.34 s against 0.44 s), and the hook is a Node process the
 * agent starts: this leaves room for that process on a loaded machine. An
 * agent whose hooks are turned off shows the ordinary box and nothing else
 * (no screen says so), and is known this soon rather than at
 * {@link START_DEADLINE_MS}.
 */
export const READY_BOUND_MS = 5_000;

/** The dialog a screen showed: its name, when the driver knows it. */
export interface DialogShown {
  /** Which dialog; absent for one the driver does not recognize. */
  readonly dialog?: StartupDialog;
}

/**
 * The dialog a reading shows, as the session waits for it: a start-up
 * dialog by its name; a panel, or a dialog the driver does not know, with
 * none.
 *
 * @param reading - A reading of a dialog or a panel.
 */
export function dialogShown(
  reading: Extract<ScreenReading, { shows: 'dialog' | 'panel' }>,
): DialogShown {
  return reading.shows === 'dialog' && reading.dialog !== undefined
    ? { dialog: reading.dialog }
    : {};
}

/** What a start-up watch works with. */
export interface StartUpWatchOptions {
  /** Reads what the screen shows now; `undefined` when it cannot be read. */
  readonly read: () => Promise<ScreenReading | undefined>;
  /** Called at each reading of a dialog: the session waits for a person in the terminal. */
  readonly onDialog: (shown: DialogShown) => void;
  /**
   * Called once the deadline passed with no dialog on screen: the watch has
   * stopped, and the session cannot be observed.
   */
  readonly onDeadline: () => void;
}

/**
 * Watches a launched agent's screen until its first hook, which stops it:
 * a dialog suspends the deadline while it shows, the input box brings it
 * nearer ({@link READY_BOUND_MS}), anything else leaves it at
 * {@link START_DEADLINE_MS}.
 */
export class StartUpWatch {
  readonly #options: StartUpWatchOptions;
  readonly #screen: ScreenWatch;
  #deadline: NodeJS.Timeout | undefined;
  #boxSeen = false;
  #dialogShown: DialogShown | undefined;

  /** @param options - See {@link StartUpWatchOptions}. */
  constructor(options: StartUpWatchOptions) {
    this.#options = options;
    this.#screen = new ScreenWatch({
      read: options.read,
      onReading: (reading) => this.#take(reading),
    });
  }

  /**
   * The dialog the screen showed when it last told something, if it was
   * one: a process that goes then left it.
   */
  get dialogShown(): DialogShown | undefined {
    return this.#dialogShown;
  }

  /** Starts watching, with the deadline from now. */
  start(): void {
    this.#arm(START_DEADLINE_MS);
    this.#screen.start();
  }

  /** Stops watching: no reading and no deadline from now on. */
  stop(): void {
    this.#screen.stop();
    clearTimeout(this.#deadline);
    this.#deadline = undefined;
  }

  #take(reading: ScreenReading): void {
    switch (reading.shows) {
      case 'dialog':
      case 'panel':
        this.#dialogShown = dialogShown(reading);
        this.#boxSeen = false;
        clearTimeout(this.#deadline);
        this.#deadline = undefined;
        this.#options.onDialog(this.#dialogShown);
        return;
      case 'input-box':
        this.#dialogShown = undefined;
        if (!this.#boxSeen) {
          this.#boxSeen = true;
          this.#arm(READY_BOUND_MS);
        }
        return;
      case 'unknown':
      case 'nothing':
        // A redraw between two screens keeps the dialog it showed last.
        if (this.#deadline === undefined) this.#arm(START_DEADLINE_MS);
        return;
    }
  }

  #arm(ms: number): void {
    clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => {
      this.stop();
      this.#options.onDeadline();
    }, ms);
  }
}
