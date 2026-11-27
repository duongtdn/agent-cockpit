import { setTimeout as pause } from 'node:timers/promises';
import { PATIENCE, POLL } from './patience.ts';

/**
 * Waits until a check passes: runs it again and again, for a bounded time,
 * and fails with its last error if it never passes. For what no event
 * announces — what a terminal shows, what a process has written.
 *
 * @param check - Throws (typically from `expect`) until what is awaited is true.
 * @param giveUp - Called before every try; what it throws ends the wait at
 * once, as its error: for when something has shown the check can no longer pass.
 * @param patienceMs - How long it may take: `PATIENCE.condition` by default.
 * @returns What the check returned when it passed.
 */
export async function eventually<T>(
  check: () => T | Promise<T>,
  giveUp: () => void = () => {},
  patienceMs: number = PATIENCE.condition,
): Promise<T> {
  const deadline = Date.now() + patienceMs;
  for (;;) {
    giveUp();
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await pause(POLL.condition);
  }
}

/**
 * Waits until something holds, for a bounded time, and tells whether it
 * did: for a wait whose end is not a failure (a key pressed again, a
 * process killed). A wait that fails when it runs out is {@link eventually}.
 *
 * @param holds - Tells whether what is awaited is true; what it throws ends the wait, as its error.
 * @param patienceMs - How long it may take, from the table of bounds.
 * @param everyMs - How often to look again.
 * @returns Whether it held before the time ran out.
 */
export async function cameTrue(
  holds: () => boolean | Promise<boolean>,
  patienceMs: number,
  everyMs: number = POLL.condition,
): Promise<boolean> {
  const deadline = Date.now() + patienceMs;
  for (;;) {
    if (await holds()) return true;
    if (Date.now() >= deadline) return false;
    await pause(everyMs);
  }
}
