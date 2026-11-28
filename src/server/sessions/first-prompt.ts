import type { Session } from '../../shared/session.js';
import type { ScreenReading, TypingOutcome } from '../driver.js';
import type { TerminalHold } from '../terminal-hold.js';
import { InputBoxWait } from './input-box-wait.js';
import { typingFailure, wrongState } from './refusals.js';
import { waitsOnAnAsk } from './session-states.js';
import type { DialogShown } from './start-up-watch.js';

/** What a launch's first prompt works with: its session, as the sessions core keeps it. */
export interface StartingSession {
  readonly key: string;
  /** Holds the keys of the page's terminals of the session. */
  readonly holds: TerminalHold;
  /** The session as it is now. */
  session(): Session;
  /** Whether a prompt may be typed into it now: launched, the cockpit not ending it, the core open. */
  takesInput(): boolean;
  /** Reads what its screen shows: `undefined` when it cannot be read. */
  readScreen(): Promise<ScreenReading | undefined>;
  /** Makes it wait for a person in the terminal. */
  waitInTerminal(shown: DialogShown): void;
  /** Types a prompt into it, the page's terminals' keys held meanwhile. */
  type(prompt: string): Promise<TypingOutcome>;
  /** Changes its state, as its followers are told. */
  update(session: Session): void;
}

/** A promise settled by hand, once; nobody need await it. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolved, rejected) => {
    resolve = resolved;
    reject = rejected;
  });
  // A close may settle it before anyone awaits it.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Why a first prompt typed after the start failed, given the session as it is then. */
type Failure = (session: Session) => unknown;

/**
 * What becomes of a launch and its first prompt. The launch settles once
 * the session left `starting`. A first prompt too long for the agent's
 * command line is typed once the agent is ready and its input box drawn:
 * the launch then settles once the agent took it, or the typing failed,
 * or the session ended, or at `waiting`, after which {@link typed} tells
 * the rest.
 */
export class FirstPrompt {
  readonly #launch = deferred<Session>();
  readonly #typed: Deferred<Session> | undefined;
  /** The prompt to type once the agent is ready; gone once begun. */
  #toType: string | undefined;
  /** Whether the launch waits for the prompt to be typed. */
  #awaitsTyping: boolean;
  #inputBoxWait: InputBoxWait | undefined;

  /** @param toType - A first prompt too long for the command line; none for any other launch. */
  constructor(toType: string | undefined) {
    this.#toType = toType;
    this.#awaitsTyping = toType !== undefined;
    this.#typed = toType === undefined ? undefined : deferred();
  }

  /** Settles once the launch did: what the session was as it left its start, or why it failed. */
  get launched(): Promise<Session> {
    return this.#launch.promise;
  }

  /**
   * What became of a first prompt typed after the start: settles once the
   * agent took it, the typing failed, or the session ended; `undefined`
   * for a launch with no such prompt.
   */
  get typed(): Promise<Session> | undefined {
    return this.#typed?.promise;
  }

  /**
   * Takes the session as it is now: the launch settles once it left the
   * start, and the first prompt once it ended, whatever the typing did.
   *
   * @param session - The session.
   */
  changed(session: Session): void {
    if (this.#leftTheStart(session)) this.#launch.resolve(session);
    if (session.state === 'ended') this.#settle(session);
  }

  /**
   * Begins typing the first prompt, the agent being ready, if one waits.
   *
   * @param session - The session to type into.
   * @returns Whether the typing began now.
   */
  typeOnceReady(session: StartingSession): boolean {
    const prompt = this.#toType;
    if (prompt === undefined) return false;
    this.#toType = undefined;
    void this.#type(session, prompt);
    return true;
  }

  /** Stops waiting for the input box: the session ended, or the core closed. */
  stop(): void {
    this.#inputBoxWait?.stop();
  }

  /**
   * Fails the launch, if it had not settled; the first prompt is left to the session's end.
   *
   * @param error - Why.
   */
  failLaunch(error: unknown): void {
    this.#launch.reject(error);
  }

  /**
   * Fails the first prompt and the launch, each if it had not settled.
   *
   * @param error - Why.
   */
  fail(error: unknown): void {
    this.#typed?.reject(error);
    this.#launch.reject(error);
  }

  /**
   * Whether the launch settles on the session as it is now: once it left
   * `starting`, or, for a first prompt typed after the start, once it waits
   * for a person or ended — the typing settles it otherwise.
   */
  #leftTheStart(session: Session): boolean {
    if (this.#awaitsTyping) return session.state === 'waiting' || session.state === 'ended';
    return session.state !== 'starting';
  }

  /** Settles the first prompt and the launch, each only if it had not settled. */
  #settle(session: Session): void {
    this.#typed?.resolve(session);
    this.#launch.resolve(session);
  }

  /**
   * Types the prompt once the agent's input box is drawn, the page's
   * terminals' keys held from the agent's start (those kept dropped, then
   * let through, while a dialog in place of the box waits for a person):
   * the session stays `starting` until the agent takes it. Not taken, no
   * box drawn in time, or the session no longer `starting` once the box
   * shows (nothing typed then), the launch fails as a send does; a
   * session still `starting` is then `idle`.
   */
  async #type(session: StartingSession, prompt: string): Promise<void> {
    const keys = heldKeys(session.holds, session.key);
    let failure: Failure | undefined;
    try {
      const shown = await this.#inputBoxShown(session, keys);
      // Ended or closed meanwhile: the end, or the close, settles the launch.
      if (!session.takesInput()) return;
      const outcome = await typedOnceShown(session, prompt, shown);
      if (outcome !== 'taken') failure = outcome;
    } catch (error) {
      failure = () => error;
    } finally {
      keys.release();
      this.#awaitsTyping = false;
    }
    this.#conclude(session, failure);
  }

  /** Settles what the typing came to: taken, or failed, a session still `starting` made `idle`. */
  #conclude(session: StartingSession, failure: Failure | undefined): void {
    const now = session.session();
    if (failure === undefined) {
      this.#settle(now);
      return;
    }
    if (!session.takesInput() || now.state !== 'starting') {
      this.fail(failure(now));
      return;
    }
    const idle: Session = { key: session.key, state: 'idle', since: new Date().toISOString() };
    this.fail(failure(idle));
    session.update(idle);
  }

  /**
   * Waits for the agent to draw its input box, which Claude Code does a
   * moment after its `SessionStart`: a dialog in its place makes the
   * session wait in the terminal, the page's terminals' keys kept so far
   * dropped, then let through for the person to answer it; `starting`
   * again, the keys held again, once the box shows.
   *
   * @returns Whether the box showed; `false` once the bound passed, or the
   * wait was stopped.
   */
  async #inputBoxShown(session: StartingSession, keys: HeldKeys): Promise<boolean> {
    const wait = new InputBoxWait({
      read: () => session.readScreen(),
      onDialog: (shown) => {
        // Typed toward the box, the keys kept would answer a dialog the person had not seen.
        keys.discard();
        session.waitInTerminal(shown);
      },
    });
    this.#inputBoxWait = wait;
    const shown = await wait.start();
    this.#inputBoxWait = undefined;
    if (!shown || !session.takesInput()) return shown;
    keys.hold();
    if (waitsOnlyInTheTerminal(session.session())) {
      session.update({ key: session.key, state: 'starting', since: new Date().toISOString() });
    }
    return shown;
  }
}

/**
 * Whether the session waits on a start-up dialog alone, which the box
 * showing answered; one that waits on an ask of its agent's (with an id)
 * stays so, and its first prompt is not typed.
 */
function waitsOnlyInTheTerminal(session: Session): boolean {
  return session.state === 'waiting' && !waitsOnAnAsk(session);
}

/**
 * Types the first prompt into the box shown, while the session is still
 * `starting`: nothing else began meanwhile (a turn of a prompt a person
 * typed, an ask).
 *
 * @returns `taken`, or why the launch fails.
 */
async function typedOnceShown(
  session: StartingSession,
  prompt: string,
  shown: boolean,
): Promise<'taken' | Failure> {
  if (!shown) return (now) => typingFailure('no-input-box', now);
  if (session.session().state !== 'starting') {
    return (now) => wrongState(now, 'Its first prompt was not typed.');
  }
  const outcome = await session.type(prompt);
  return outcome === 'taken' ? outcome : (now) => typingFailure(outcome, now);
}

/** A hold of the page's terminals' keys of a session, let go and taken again. */
interface HeldKeys {
  /** Holds the keys, unless they are held already. */
  hold(): void;
  /** Lets the keys through, if they are held: those kept reach the session first. */
  release(): void;
  /** Lets the keys through, if they are held, the keys kept dropped. */
  discard(): void;
}

/** Holds the page's terminals' keys of a session from now on. */
function heldKeys(holds: TerminalHold, key: string): HeldKeys {
  let release: (() => void) | undefined = holds.hold(key);
  return {
    hold() {
      release ??= holds.hold(key);
    },
    release() {
      release?.();
      release = undefined;
    },
    discard() {
      if (release === undefined) return;
      holds.discard(key);
      this.release();
    },
  };
}
