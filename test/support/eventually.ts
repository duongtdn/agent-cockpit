import { vi } from 'vitest';

/** How long something may take to come true before a test fails. */
const TIMEOUT_MS = 5000;
const INTERVAL_MS = 20;

/**
 * Waits until a check passes: runs it again and again, for a bounded time,
 * and fails with its last error if it never passes. For what no event
 * announces — what a terminal shows, what a process has written.
 *
 * @param check - Throws (typically from `expect`) until what is awaited is true.
 * @returns What the check returned when it passed.
 */
export function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: TIMEOUT_MS, interval: INTERVAL_MS });
}
