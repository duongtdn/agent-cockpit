import type { ScreenReading, ScreenStateSigns } from '../driver.js';
import { ScreenWatch } from './screen-watch.js';
import { type DialogShown, dialogShown } from './start-up-watch.js';

/**
 * How long after its first hook an agent launched with a prompt may show a
 * screen the driver does not know before the session waits in the terminal
 * for a person to look. Claude Code takes a launch prompt 0.1–0.17 s after
 * its `SessionStart`, and a local command writes its end 0.25–0.35 s after
 * it; a panel it opens is drawn within 0.2 s. Five seconds leaves a loaded
 * machine twenty times that, and is paid only by a panel the driver has no
 * words for.
 */
export const PROMPT_BOUND_MS = 5_000;

/**
 * How many reads in a row must show a screen the driver does not know: tmux
 * was seen to give a screen half written, which the next read no longer
 * shows.
 */
const UNKNOWN_READS = 2;

/** What a launch prompt's watch works with. */
export interface LaunchPromptWatchOptions {
  /** Reads the screen's text now; `undefined` when it cannot be read. */
  readonly read: () => Promise<string | undefined>;
  /** Reads where to type and what waits for a person: the driver's `readScreen`. */
  readonly readScreen: (text: string) => ScreenReading;
  /** The driver's signs of the agent's state, of which only a launch panel's close is read here. */
  readonly signs: Pick<ScreenStateSigns, 'launchPanelClosed'>;
  /** Called at each reading of a panel or a dialog: the session waits for a person in the terminal. */
  readonly onPanel: (shown: DialogShown) => void;
  /** Called once a named panel seen is closed: the watch has stopped, and the agent waits for a prompt. */
  readonly onPanelClosed: () => void;
}

/**
 * Reads the screen of an agent launched with a prompt that no hook said it
 * took, until stopped (the session's next hook, or what its transcript
 * records, tells the rest). A local command that opens a panel writes
 * nothing while the panel shows, nor once it is closed: the panel makes the
 * session wait in the terminal, and the close of a panel the driver names,
 * read by its sign, is the command's end. A screen the driver does not
 * know, shown past {@link PROMPT_BOUND_MS}, is taken for a panel it has no
 * words for, and a dialog with no name is one too: a person must look, and
 * the box seen again ends neither (a start stalled before the prompt was
 * taken shows the box too); only the next hook or entry does. The input box
 * alone is no sign of anything: the agent draws it before it takes the
 * prompt.
 */
export class LaunchPromptWatch {
  readonly #options: LaunchPromptWatchOptions;
  readonly #screen: ScreenWatch<string>;
  #startedAt = 0;
  #namedPanelSeen = false;
  #unknownReads = 0;

  /** @param options - See {@link LaunchPromptWatchOptions}. */
  constructor(options: LaunchPromptWatchOptions) {
    this.#options = options;
    this.#screen = new ScreenWatch({ read: options.read, onReading: (text) => this.#take(text) });
  }

  /** Starts watching, the bound from now: the first read one interval from now. */
  start(): void {
    this.#startedAt = Date.now();
    this.#screen.start();
  }

  /** Stops watching: nothing is called from now on. */
  stop(): void {
    this.#screen.stop();
  }

  #take(text: string): void {
    if (this.#namedPanelSeen && this.#options.signs.launchPanelClosed(text)) {
      this.stop();
      this.#options.onPanelClosed();
      return;
    }
    const reading = this.#options.readScreen(text);
    this.#unknownReads = reading.shows === 'unknown' ? this.#unknownReads + 1 : 0;
    if (reading.shows === 'panel') this.#namedPanelSeen = true;
    if (reading.shows === 'dialog' || reading.shows === 'panel') {
      this.#options.onPanel(dialogShown(reading));
    } else if (this.#showsAnUnknownPanel()) {
      this.#options.onPanel({});
    }
  }

  #showsAnUnknownPanel(): boolean {
    return this.#unknownReads >= UNKNOWN_READS && Date.now() - this.#startedAt >= PROMPT_BOUND_MS;
  }
}
