/** The first wait before a reconnection; it doubles after each failure. */
const FIRST_DELAY_MS = 500;
/**
 * The longest wait: a cockpit back from a restart is reached again within
 * seconds, and one attempt every few seconds costs a loopback server nothing.
 */
const LONGEST_DELAY_MS = 10_000;

/**
 * How long a stream of the wire waits before it reconnects: 0.5 s after a
 * first failure, doubling after each one, up to 10 s.
 *
 * @param failures - How many attempts failed in a row before this one.
 * @returns The wait, in milliseconds.
 */
export function reconnectDelay(failures: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** failures, LONGEST_DELAY_MS);
}
