import { setTimeout as pause } from 'node:timers/promises';
import type { AgentSession } from '../support/agent-session.ts';

/**
 * Keys on the start-up dialogs of the real agent, as a person presses them,
 * for the parity scenarios and the driver's rows alike.
 */

/** How long a key on a start-up dialog is given to be taken before it is pressed again. */
const DIALOG_KEY_PATIENCE_MS = 1000;
const DIALOG_KEY_PRESSES = 3;
const SCREEN_POLL_MS = 20;

/**
 * How long the selection of a start-up dialog must stay before it is
 * chosen: seen of 2.1.332, a dialog draws itself again about 150 ms after
 * it showed, its selection back on its first option.
 */
const SELECTION_SETTLES_MS = 500;

/**
 * Gives what a session shows.
 *
 * @returns The screen, or `undefined` once the session is gone.
 */
export async function screenOrNothing(session: AgentSession): Promise<string | undefined> {
  if (!(await session.isLive())) return undefined;
  return session.screen().catch(() => undefined);
}

/**
 * Presses a key on a start-up dialog until it is taken, as the screen
 * tells: the real agent's dialog was seen to drop the keys pressed in the
 * moment after it showed, as its input box drops an early Enter.
 *
 * @param taken - Tells from the screen, or from its absence once the session is gone, that the key was taken.
 * @throws Error when the key was not taken after a few presses.
 */
export async function pressOnDialog(
  session: AgentSession,
  key: string,
  taken: (screen: string | undefined) => boolean,
): Promise<void> {
  for (let presses = 1; presses <= DIALOG_KEY_PRESSES; presses++) {
    await session.press(key);
    const deadline = Date.now() + DIALOG_KEY_PATIENCE_MS;
    while (Date.now() < deadline) {
      if (taken(await screenOrNothing(session))) return;
      await pause(SCREEN_POLL_MS);
    }
  }
  throw new Error(`The dialog did not take ${key} in ${DIALOG_KEY_PRESSES} presses.`);
}

/** Tells whether a selection stays on screen for a while, or stops as soon as it is gone. */
async function stays(session: AgentSession, selected: RegExp): Promise<boolean> {
  const until = Date.now() + SELECTION_SETTLES_MS;
  while (Date.now() < until) {
    if (!selected.test((await screenOrNothing(session)) ?? '')) return false;
    await pause(SCREEN_POLL_MS);
  }
  return true;
}

/**
 * Selects a start-up dialog's "Yes", once it stays selected, and chooses it.
 *
 * @param dialog - A text of the dialog, gone from the screen once it is answered.
 * @param move - The key that moves the selection to "Yes".
 * @throws Error when the dialog does not keep "Yes" selected, or does not take the Enter.
 */
export async function answerYes(
  session: AgentSession,
  dialog: string,
  move: 'Up' | 'Down',
): Promise<void> {
  const yes = /❯ Yes/u;
  for (let tries = 1; ; tries++) {
    await pressOnDialog(session, move, (screen) => yes.test(screen ?? ''));
    if (await stays(session, yes)) break;
    if (tries === DIALOG_KEY_PRESSES) throw new Error(`The dialog did not keep "Yes" selected.`);
  }
  await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(dialog));
}
