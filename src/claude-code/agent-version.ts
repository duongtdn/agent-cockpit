import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentVersion, TestedRange } from '../server/agent-status.js';
import { AGENT_COMMAND } from './launching.js';

const run = promisify(execFile);

/** A version as Claude Code prints it: three numbers, first on its `--version` line. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?=\s|$)/;

/**
 * Reads the version of the `claude` a launch with this environment would
 * run: `claude --version`, looked up on the environment's `PATH`.
 *
 * @param environment - The launch's environment.
 * @param range - The tested range the version stands against.
 * @returns The version and its standing, or that no agent was found.
 * @throws An `Error` when the agent fails, or prints no version.
 */
export async function readAgentVersion(
  environment: Readonly<Record<string, string>>,
  range: TestedRange,
): Promise<AgentVersion> {
  let printed: string;
  try {
    printed = (await run(AGENT_COMMAND, ['--version'], { env: environment })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { found: false, command: AGENT_COMMAND };
    }
    throw error;
  }
  const version = parseVersion(printed);
  if (version === undefined) throw new Error(`claude --version printed no version: ${printed}`);
  return { found: true, version, standing: standingOf(version, range) };
}

/**
 * Reads the version in what `claude --version` printed (`2.1.332 (Claude Code)`).
 *
 * @returns The version; `undefined` when the text holds none.
 */
export function parseVersion(printed: string): string | undefined {
  return VERSION.exec(printed.trim())?.[0];
}

/**
 * Stands a version against the tested range, number by number.
 *
 * @param version - A version of three numbers.
 * @param range - The tested range.
 * @returns Whether it lies within the range, after it, or before it.
 */
export function standingOf(version: string, range: TestedRange): 'tested' | 'newer' | 'older' {
  if (compare(version, range.oldest) < 0) return 'older';
  if (compare(version, range.newest) > 0) return 'newer';
  return 'tested';
}

function compare(a: string, b: string): number {
  const [left, right] = [numbersOf(a), numbersOf(b)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function numbersOf(version: string): number[] {
  return version.split('.').map(Number);
}
