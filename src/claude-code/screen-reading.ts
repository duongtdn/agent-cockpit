import type { ScreenReading } from '../server/driver.js';

/**
 * Reads Claude Code's screen while the cockpit waits for its first hook.
 * This version recognizes no screen yet: every one shows nothing it can
 * tell.
 *
 * @param _text - The screen, line by line.
 * @returns What it shows.
 */
export function readScreen(_text: string): ScreenReading {
  return { shows: 'nothing' };
}
