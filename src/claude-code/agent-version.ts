import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentVersion, TestedRange } from '../server/agent-status.js';
import { AGENT_COMMAND } from './launching.js';

const run = promisify(execFile);

/** A version as Claude Code prints it: three numbers, first on its `--version` line. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?=\s|$)/;

/** An executable as a cache knows it: the file it really is, as it was when read. */
interface ExecutableFile {
  /** Its real path: every link to it leads there. */
  readonly realPath: string;
  /** When it last changed, which an update of the agent changes. */
  readonly changedMs: number;
}

/**
 * Creates the reader of the version of the `claude` a launch would run:
 * the first executable `claude` on the launch's `PATH`, asked
 * `claude --version`. The agent is asked once per executable, known by its
 * real path and its time of change, so that a launch after the first pays
 * a few file lookups and not a process; an update of the agent, which
 * replaces the file or the link to it, is read anew.
 *
 * @param range - The tested range the version stands against.
 * @returns The reader. It gives the version and its standing, or that no
 * agent was found; it rejects with an `Error` when the agent fails, or
 * prints no version, and keeps no such failure.
 */
export function agentVersionReader(
  range: TestedRange,
): (environment: Readonly<Record<string, string>>) => Promise<AgentVersion> {
  const versions = new Map<string, { readonly changedMs: number; readonly version: string }>();

  return async (environment) => {
    const program = await findOnPath(AGENT_COMMAND, environment.PATH);
    if (program === undefined) return { found: false, command: AGENT_COMMAND };
    const file = await executableFile(program);
    let version = versions.get(file.realPath);
    if (version?.changedMs !== file.changedMs) {
      version = { changedMs: file.changedMs, version: await askVersion(program, environment) };
      versions.set(file.realPath, version);
    }
    return { found: true, version: version.version, standing: standingOf(version.version, range) };
  };
}

/**
 * Finds a program as a launch would: in the first folder of the `PATH` that
 * holds an executable file of that name. Only absolute folders count: a
 * relative one would depend on the folder the server runs in.
 */
async function findOnPath(name: string, path: string | undefined): Promise<string | undefined> {
  for (const folder of (path ?? '').split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function executableFile(program: string): Promise<ExecutableFile> {
  const realPath = await realpath(program);
  return { realPath, changedMs: (await stat(realPath)).mtimeMs };
}

async function askVersion(
  program: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const printed = (await run(program, ['--version'], { env: environment })).stdout;
  const version = parseVersion(printed);
  if (version === undefined) throw new Error(`claude --version printed no version: ${printed}`);
  return version;
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
