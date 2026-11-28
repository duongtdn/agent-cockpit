import type { Session } from '../../shared/session.js';
import type { ScreenStateSigns } from '../driver.js';
import { ScreenWatch } from './screen-watch.js';

/** What a session's withdrawn-prompt watch works with. */
export interface WithdrawnWatchOptions {
  /**
   * Reads the screen's text now; `undefined` when it cannot be read, or
   * shows a person's scrolling back, which is skipped.
   */
  readonly read: () => Promise<string | undefined>;
  /** The driver's signs of the agent's state, of which only a withdrawn prompt is read here. */
  readonly signs: Pick<ScreenStateSigns, 'promptWithdrawn'>;
  /**
   * Called once the screen shows the prompt withdrawn: the watch has
   * stopped, and the agent waits for a prompt. The `idle` session it makes
   * begins the stretch {@link WithdrawnWatch.isIdleSinceWithdrawn} tells.
   */
  readonly onWithdrawn: () => void;
}

/**
 * Reads a session's screen, while its open turn's prompt may be withdrawn,
 * for the one fact nothing else tells: an Esc pressed before the model
 * answered put the prompt back into the empty input box, and the turn is
 * over. It serves an Esc a person pressed in the terminal and the
 * cockpit's own interrupt alike. The core says which prompt may be
 * withdrawn as the session's course changes, and none once the turn told
 * anything else, ended, or the session is not `busy`. The first read of a
 * prompt is one interval after it was taken: the agent redraws the
 * withdrawn box a tenth of a second or more after the Esc.
 */
export class WithdrawnWatch {
  readonly #options: WithdrawnWatchOptions;
  #prompt: string | undefined;
  #screen: ScreenWatch<string> | undefined;
  /** Whether {@link WithdrawnWatchOptions.onWithdrawn} runs: the change it makes is the withdrawn idle. */
  #withdrawing = false;
  /** Whether the session is `idle` since the screen showed the prompt withdrawn. */
  #idleSinceWithdrawn = false;

  /** @param options - See {@link WithdrawnWatchOptions}. */
  constructor(options: WithdrawnWatchOptions) {
    this.#options = options;
  }

  /**
   * Watches for this prompt withdrawn: goes on for the prompt it watches
   * already, starts anew for another, stops for none.
   *
   * @param prompt - The open turn's prompt while it may be withdrawn; `undefined` for none.
   */
  follow(prompt: string | undefined): void {
    if (prompt !== undefined && prompt === this.#prompt) return;
    this.stop();
    if (prompt === undefined) return;
    this.#prompt = prompt;
    this.#screen = new ScreenWatch({
      read: this.#options.read,
      onReading: (text) => this.#take(text, prompt),
    });
    this.#screen.start();
  }

  /**
   * Takes the session at each of its changes: the `idle` session made as
   * the prompt was read withdrawn begins an idle stretch that lasts until
   * the session leaves `idle` (a task finishing changes it, and keeps it so).
   *
   * @param session - The session as it is now.
   */
  changed(session: Session): void {
    if (session.state !== 'idle') this.#idleSinceWithdrawn = false;
    else if (this.#withdrawing) this.#idleSinceWithdrawn = true;
  }

  /** Whether the session is `idle` since the screen showed the turn's prompt withdrawn. */
  isIdleSinceWithdrawn(): boolean {
    return this.#idleSinceWithdrawn;
  }

  /** Stops watching: nothing is called from now on, until a prompt is followed again. */
  stop(): void {
    this.#screen?.stop();
    this.#screen = undefined;
    this.#prompt = undefined;
  }

  #take(text: string, prompt: string): void {
    if (!this.#options.signs.promptWithdrawn(text, prompt)) return;
    this.stop();
    this.#withdrawing = true;
    try {
      this.#options.onWithdrawn();
    } finally {
      this.#withdrawing = false;
    }
  }
}
