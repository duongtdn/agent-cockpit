import type { Session, SessionState } from '../../shared/session.js';
import {
  type DraftTerminal,
  type DriverEvent,
  type InputBox,
  type TerminalScreen,
  TypingStoppedError,
  type TypingTerminal,
} from '../driver.js';
import type { SessionHost } from '../session-host/session-host.js';
import { SessionHostError } from '../session-host/session-host-error.js';

/** What a session's typing terminal works with. */
export interface TypingTerminalOptions {
  /** The session's key, its name on the host. */
  readonly key: string;
  /** Where the session lives. */
  readonly host: Pick<SessionHost, 'sendText' | 'sendKeys' | 'readScreen'>;
  /** Reads the agent's input box from its screen: the driver's. */
  readonly readInputBox: (text: string) => InputBox | undefined;
  /**
   * The session as its hooks tell it now; `undefined` once the core no
   * longer hears it (ended, being ended, or the core closed).
   */
  readonly session: () => Session | undefined;
}

/**
 * A live session's terminal, as the core gives it to the driver to type a
 * prompt: every write checked first, against the hooks and the screen.
 *
 * Until a prompt is taken, the session must stay in the state the typing
 * began in (`idle`, or `starting` for a first prompt typed after the
 * start): a turn begun by itself, an ask, a dialog or its end stops the
 * typing. Once one is taken, only its own turn may show (`busy`, or
 * `idle` again once it ended): a prompt taken that is not the one typed,
 * or anything waiting for a person, stops it. Before every write the
 * screen must show the input box, as the driver reads it. Once stopped,
 * the driver may still put the person's draft back through
 * {@link restoring}, whose writes need only the session heard and its box
 * shown.
 */
export class SessionTypingTerminal implements TypingTerminal {
  readonly #options: TypingTerminalOptions;
  readonly #begunIn: SessionState | undefined;
  /** The prompts the agent took since the typing began, in order; `undefined` for one with no text. */
  readonly #taken: (string | undefined)[] = [];
  readonly #waiters = new Set<() => void>();
  /** The prompt the driver waits for, as the agent carries it, once it says. */
  #expected: string | undefined;
  #stopped = false;
  /** Whether a write to put the draft back was refused: every later one is. */
  #restoreStopped = false;
  #closed = false;

  readonly restoring: DraftTerminal = {
    typeText: (text) => this.#restoreChecked(() => this.#typeText(text)),
    pressKeys: (keys) => this.#restoreChecked(() => this.#pressKeys(keys)),
    readScreen: () => this.readScreen(),
  };

  constructor(options: TypingTerminalOptions) {
    this.#options = options;
    this.#begunIn = options.session()?.state;
  }

  /** Takes what the session's hooks told while the prompt is typed. */
  heard(events: readonly DriverEvent[]): void {
    for (const event of events) {
      if (event.type !== 'prompt-taken') continue;
      this.#taken.push(event.prompt);
      for (const waiter of this.#waiters) waiter();
    }
  }

  /** Ends the terminal: every later write is refused, and no wait goes on. */
  close(): void {
    this.#stopped = true;
    this.#closed = true;
    for (const waiter of this.#waiters) waiter();
  }

  async typeText(text: string): Promise<void> {
    await this.#checked(() => this.#typeText(text));
  }

  async pressKeys(keys: readonly string[]): Promise<void> {
    await this.#checked(() => this.#pressKeys(keys));
  }

  async readScreen(): Promise<TerminalScreen> {
    const { text, cursor } = await this.#options.host.readScreen(this.#options.key);
    return { text, cursor };
  }

  promptTaken(prompt: string, withinMs: number): Promise<boolean> {
    this.#expected = prompt;
    return new Promise((resolve) => {
      const answer = (taken: boolean): void => {
        clearTimeout(timer);
        this.#waiters.delete(look);
        resolve(taken);
      };
      const look = (): void => {
        if (this.#taken.includes(prompt)) answer(true);
        else if (this.#stopped) answer(false);
      };
      const timer = setTimeout(() => answer(false), withinMs);
      this.#waiters.add(look);
      look();
    });
  }

  /** Runs a write once the session is checked; a refused check refuses every later write. */
  async #checked(write: () => Promise<void>): Promise<void> {
    const why = this.#refusalByHooks() ?? (await this.#refusalByScreen());
    if (why !== undefined) {
      this.#stopped = true;
      throw new TypingStoppedError(why);
    }
    await this.#written(write, () => {
      this.#stopped = true;
    });
  }

  /** Runs a write that puts the draft back once the session is heard and its box shown. */
  async #restoreChecked(write: () => Promise<void>): Promise<void> {
    const why = this.#refusalToRestore() ?? (await this.#refusalByScreen());
    if (why !== undefined) {
      this.#restoreStopped = true;
      throw new TypingStoppedError(why);
    }
    await this.#written(write, () => {
      this.#restoreStopped = true;
    });
  }

  /** Runs a write; a session gone meanwhile stops the writes. */
  async #written(write: () => Promise<void>, stop: () => void): Promise<void> {
    try {
      await write();
    } catch (error) {
      if (error instanceof SessionHostError && error.reason === 'no-session') {
        stop();
        throw new TypingStoppedError('The session is gone.');
      }
      throw error;
    }
  }

  #typeText(text: string): Promise<void> {
    return this.#options.host.sendText(this.#options.key, text, {
      // One write: the driver sizes it, small enough to read as typing.
      chunkLength: Math.max(1, Array.from(text).length),
      pauseMs: 0,
    });
  }

  #pressKeys(keys: readonly string[]): Promise<void> {
    return this.#options.host.sendKeys(this.#options.key, keys);
  }

  #refusalToRestore(): string | undefined {
    if (this.#closed) return 'The typing is over.';
    if (this.#restoreStopped) return 'Putting the draft back was stopped.';
    return this.#options.session() === undefined ? 'The session is no longer heard.' : undefined;
  }

  #refusalByHooks(): string | undefined {
    if (this.#stopped) return 'The typing was stopped.';
    const session = this.#options.session();
    if (session === undefined) return 'The session is no longer heard.';
    if (this.#taken.length === 0) {
      return session.state === this.#begunIn
        ? undefined
        : `The session is ${session.state}: the typing began at ${this.#begunIn}.`;
    }
    if (this.#taken.some((prompt) => prompt !== this.#expected)) {
      return 'The agent took a prompt other than the one typed.';
    }
    return session.state === 'busy' || session.state === 'idle'
      ? undefined
      : `The session is ${session.state}, inside the prompt's turn.`;
  }

  async #refusalByScreen(): Promise<string | undefined> {
    const { text } = await this.readScreen().catch((error: unknown) => {
      if (error instanceof SessionHostError && error.reason === 'no-session') return { text: '' };
      throw error;
    });
    return this.#options.readInputBox(text) === undefined
      ? 'The screen shows no input box.'
      : undefined;
  }
}
