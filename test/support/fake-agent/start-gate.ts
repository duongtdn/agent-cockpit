import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

/**
 * The file of a session's folder that keeps a fake agent from getting ready:
 * while it exists, the agent stays where Claude Code is while it starts,
 * before `SessionStart`.
 */
export const START_GATE_FILE_NAME = '.fake-agent-hold-start';

/** How often a held agent looks whether it may get ready, in milliseconds. */
const GATE_CHECK_MS = 10;

function gateOf(folder: string): string {
  return join(folder, START_GATE_FILE_NAME);
}

/**
 * Holds the start of the fake agents launched in a folder, for a test of
 * what happens before `SessionStart`.
 *
 * @param folder - The sessions' working folder; it must exist.
 */
export function holdStart(folder: string): void {
  writeFileSync(gateOf(folder), '');
}

/** Lets the fake agents held in a folder get ready. */
export function releaseStart(folder: string): void {
  rmSync(gateOf(folder), { force: true });
}

/**
 * Waits until nothing holds the start of the agents of a folder.
 *
 * @returns A promise fulfilled at once when nothing holds it.
 */
export async function startReleased(folder: string): Promise<void> {
  while (existsSync(gateOf(folder))) await pause(GATE_CHECK_MS);
}
