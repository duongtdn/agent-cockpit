import type { AgentSession } from '../support/agent-session.ts';
import { cameTrue } from '../support/eventually.ts';
import { PATIENCE, POLL } from '../support/patience.ts';

/**
 * Keys on the dialogs of the real agent (its start-up dialogs, a tool's
 * permission dialog), as a person presses them, for the driver's rows.
 */

/** How many times a key is pressed on a dialog that shows nothing of it. */
const DIALOG_KEY_PRESSES = 3;

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
    if (await pressedOrGone(session, key, taken)) return;
    const shown = async () => taken(await screenOrNothing(session));
    if (await cameTrue(shown, PATIENCE.dialogKey, POLL.screen)) return;
  }
  throw new Error(`The dialog did not take ${key} in ${DIALOG_KEY_PRESSES} presses.`);
}

/**
 * Presses a key, and tells whether the session went with the keys before:
 * an agent that took a key may act on it slower than a press is repeated,
 * and leave as that press reaches its terminal.
 *
 * @returns Whether the session is gone, as `taken` asked.
 * @throws The press's error when the session lives, or when its going is not what was asked.
 */
async function pressedOrGone(
  session: AgentSession,
  key: string,
  taken: (screen: string | undefined) => boolean,
): Promise<boolean> {
  try {
    await session.press(key);
    return false;
  } catch (error) {
    if (!(await session.isLive()) && taken(undefined)) return true;
    throw error;
  }
}

/**
 * Tells whether a selection stays on screen through the dialog's redraw, or
 * stops as soon as it is gone: seen of 2.1.332, a dialog draws itself again
 * about 150 ms after it showed, its selection back on its first option. No
 * sign tells the redraw came, so the selection is watched for the time it
 * may take.
 */
async function stays(session: AgentSession, selected: RegExp): Promise<boolean> {
  const gone = async () => !selected.test((await screenOrNothing(session)) ?? '');
  return !(await cameTrue(gone, PATIENCE.dialogRedraw, POLL.screen));
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

/**
 * Moves a dialog's selection a row at a time until a row stays selected: a
 * move the dialog dropped leaves the selection where it was and is pressed
 * again, and a redraw that puts the selection back on the first row is
 * moved on from.
 *
 * @param selected - The selected row, as the screen shows it.
 * @param move - The key that moves the selection towards it.
 * @param rows - How many rows the dialog offers: each move may be pressed a few times.
 * @throws Error when the row is not kept selected within those presses.
 */
export async function selectOnDialog(
  session: AgentSession,
  selected: RegExp,
  move: 'Up' | 'Down',
  rows: number,
): Promise<void> {
  for (let presses = 0; presses < rows * DIALOG_KEY_PRESSES; presses++) {
    if (selected.test((await screenOrNothing(session)) ?? '') && (await stays(session, selected))) {
      return;
    }
    const before = selectionOn(await screenOrNothing(session));
    await session.press(move);
    const moved = async () => selectionOn(await screenOrNothing(session)) !== before;
    await cameTrue(moved, PATIENCE.dialogKey, POLL.screen);
  }
  throw new Error(`The dialog did not keep ${selected} selected.`);
}

/**
 * The row a dialog's pointer marks: a numbered option, never the prompt
 * the transcript shows above the dialog with the same sign.
 */
function selectionOn(screen: string | undefined): string | undefined {
  return /^[ \t]*❯ \d+\. .*$/mu.exec(screen ?? '')?.[0];
}
