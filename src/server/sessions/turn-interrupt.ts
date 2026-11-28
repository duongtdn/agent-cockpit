import { CockpitError } from '../../shared/cockpit-error.js';
import type { InterruptResult, Session } from '../../shared/session.js';
import type { InputBoxClearing, SessionInterrupting } from '../driver.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import { settlesBeforeAbort } from './abort-race.js';
import { wrongState } from './refusals.js';

/**
 * What an interrupt does with a session: nothing, there being no turn to
 * stop; refuse, the session not yet started; or stop its turn.
 */
export type Interruption = 'nothing' | 'refused' | 'stop-the-turn';

/**
 * Tells what an interrupt does with a session, as it is.
 *
 * | Session | Interrupt |
 * |---|---|
 * | none, `idle`, `ended` | Nothing: no turn runs. |
 * | `starting` | Refused. |
 * | `busy` | Stops the turn. |
 * | `waiting` in the terminal only (a start-up dialog, a panel, a screen the driver cannot read) | Nothing: no turn runs behind it, and a key could answer a dialog the cockpit never answers. |
 * | `waiting` on anything else (an ask, a channel request, an ask shown in the terminal) | Stops the turn. |
 *
 * @param session - The session, `undefined` when there is none.
 * @returns What the interrupt does.
 */
export function interruptionOf(session: Session | undefined): Interruption {
  switch (session?.state) {
    case undefined:
    case 'idle':
    case 'ended':
      return 'nothing';
    case 'starting':
      return 'refused';
    case 'busy':
      return 'stop-the-turn';
    case 'waiting':
      return session.pending.every((each) => each.kind === 'terminal' && each.id === undefined)
        ? 'nothing'
        : 'stop-the-turn';
  }
}

/** What an interrupt works with: the session, as the sessions core keeps it. */
export interface InterruptedSession {
  readonly key: string;
  /** The session as it is now: `undefined` when there is none. */
  session(): Session | undefined;
  /**
   * Calls the listener with the session at each change, until the function
   * returned is called.
   */
  onChange(listener: (session: Session) => void): () => void;
  /**
   * Presses keys in the session's terminal, leaving a person's scrolling
   * back first. Nothing is pressed once the cockpit is ending the session;
   * a session found gone is ended. Rejects with what the host fails with.
   */
  pressKeys(keys: readonly string[]): Promise<void>;
  /** Whether this `idle` session is the one the screen showed with the turn's prompt withdrawn. */
  wasWithdrawn(session: Session): boolean;
  /**
   * Clears the agent's input box, the page's terminals' keys held
   * meanwhile. Rejects with what the host fails with.
   */
  clearInputBox(): Promise<InputBoxClearing>;
}

/** The interrupt's ways, and when it gives up. */
export interface InterruptOptions {
  /** How the driver stops a turn, and how long the session has to be `idle` after it. */
  readonly interrupting: SessionInterrupting;
  /** Aborted by the core's close: the wait stops, and the interrupt is refused. */
  readonly closing: AbortSignal;
  /** What the interrupt is refused with once the core is closed. */
  readonly refusal: () => unknown;
}

/**
 * Interrupts a session's turn, as {@link interruptionOf} says, and resolves
 * once that is confirmed.
 *
 * A turn is stopped by the driver's keys, pressed once and never again,
 * whatever follows. The session then has the driver's bound to be `idle`:
 * the turn ended, the transcript recorded the interruption, or the screen
 * showed the prompt withdrawn, which is then cleared from the input box,
 * since the app asked to stop. However the clearing ends — the box left
 * holding text, none shown, the host failing — the interrupt resolves
 * `interrupted`: the turn did stop. A session that ends meanwhile had no
 * turn left to stop.
 *
 * @param target - The session.
 * @param options - See {@link InterruptOptions}.
 * @returns `interrupted` once the session is `idle`; `nothing-to-interrupt`
 * with the session's state (none for no session) when no turn runs, or
 * once the session ended.
 * @throws `CockpitError` `wrong-state` on a `starting` session;
 * `interrupt-unconfirmed` with the key and the last state when the session
 * was not `idle` within the bound: it is left as it is. What the host fails
 * with as the keys are pressed. The refusal once the core is closed first.
 */
export async function interruptTurn(
  target: InterruptedSession,
  options: InterruptOptions,
): Promise<InterruptResult> {
  const session = target.session();
  const interruption = interruptionOf(session);
  if (session === undefined || interruption === 'nothing') return nothingToInterrupt(session);
  if (interruption === 'refused') throw wrongState(session);
  return stopTheTurn(target, options);
}

async function stopTheTurn(
  target: InterruptedSession,
  { interrupting, closing, refusal }: InterruptOptions,
): Promise<InterruptResult> {
  // Listened to before the keys, which the turn's end may answer at once.
  const rest = restingState(target);
  try {
    await target.pressKeys(interrupting.busy.keys);
    const settled = await within(rest.reached, interrupting.boundMs, closing);
    if (closing.aborted) throw refusal();
    if (settled === undefined) throw unconfirmed(target);
    if (settled.state === 'ended') return nothingToInterrupt(settled);
    if (target.wasWithdrawn(settled)) await clearWithdrawnPrompt(target);
    return { action: 'interrupted', state: 'idle' };
  } finally {
    rest.stop();
  }
}

/** Clears the prompt the interrupt withdrew: the turn stopped, whatever the clearing comes to. */
async function clearWithdrawnPrompt(target: InterruptedSession): Promise<void> {
  try {
    await target.clearInputBox();
  } catch (error) {
    if (!(error instanceof SessionHostError)) throw error;
  }
}

/** The next `idle` or `ended` session, as the target tells its changes. */
function restingState(target: InterruptedSession): {
  readonly reached: Promise<Session>;
  stop(): void;
} {
  let stop = () => {};
  const reached = new Promise<Session>((resolve) => {
    stop = target.onChange((session) => {
      if (session.state === 'idle' || session.state === 'ended') resolve(session);
    });
  });
  return { reached, stop: () => stop() };
}

/** What the promise gives within the time, in milliseconds; `undefined` past it, or once the signal aborted. */
async function within<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const bounded = Promise.race([promise, timedOut]);
  try {
    return (await settlesBeforeAbort(bounded, signal)) ? await bounded : undefined;
  } finally {
    clearTimeout(timer);
  }
}

function nothingToInterrupt(session: Session | undefined): InterruptResult {
  return session === undefined
    ? { action: 'nothing-to-interrupt' }
    : { action: 'nothing-to-interrupt', state: session.state };
}

function unconfirmed(target: InterruptedSession): CockpitError<'interrupt-unconfirmed'> {
  const state = target.session()?.state ?? 'ended';
  return new CockpitError(
    'interrupt-unconfirmed',
    `The session ${target.key} was not seen idle after its turn was interrupted; it is ${state}.`,
    { key: target.key, state },
  );
}
