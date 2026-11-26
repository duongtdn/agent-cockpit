import { setTimeout as pause } from 'node:timers/promises';

/** How long something may take to come true before a test fails, unless the test says. */
const TIMEOUT_MS = 5000;
const INTERVAL_MS = 20;

/**
 * Waits until a check passes: runs it again and again, for a bounded time,
 * and fails with its last error if it never passes. For what no event
 * announces — what a terminal shows, what a process has written.
 *
 * @param check - Throws (typically from `expect`) until what is awaited is true.
 * @param giveUp - Called before every try; what it throws ends the wait at
 * once, as its error: for when something has shown the check can no longer pass.
 * @param patienceMs - How long it may take: 5 s by default.
 * @returns What the check returned when it passed.
 */
export async function eventually<T>(
  check: () => T | Promise<T>,
  giveUp: () => void = () => {},
  patienceMs = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + patienceMs;
  for (;;) {
    giveUp();
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await pause(INTERVAL_MS);
  }
}
