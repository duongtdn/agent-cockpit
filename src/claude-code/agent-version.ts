import { realpath, stat } from 'node:fs/promises';
import type { AgentFailure, AgentVersion, TestedRange } from '../server/agent-status.js';
import { runBounded } from './bounded-run.js';
import { AGENT_COMMAND, findProgram } from './launching.js';

/**
 * A version as Claude Code prints it, first on its `--version` line: three
 * numbers, and maybe a suffix of a pre-release or a build (`-beta`,
 * `+local`), as semantic versioning writes them.
 */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*[0-9A-Za-z])?(?=\s|$)/;

/**
 * How long `claude --version` may take before the agent counts as one that
 * cannot be run. The pinned agent, a native program, answers in about 10
 * ms; an agent installed as a Node script starts in a second or two on a
 * loaded machine. Ten seconds is far above either, and still well below the
 * 30 to 60 seconds after which a browser or a proxy gives up on the request
 * that launches, so the app gets the refusal and its reason.
 */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * An executable as the cache knows it: the file it really is, as it was
 * when read. An update of the agent replaces the file (another inode) or
 * rewrites it (another time of change, or of status change when a copy
 * keeps the time of change).
 */
interface ExecutableFile {
  /** Its real path: every link to it leads there. */
  readonly realPath: string;
  /** Its inode, its time of change and its time of status change, in nanoseconds. */
  readonly identity: string;
}

/** What one run of `claude --version` gave. */
type Answer = { readonly version: string } | { readonly failure: AgentFailure };

/**
 * Creates the reader of the version of the `claude` a launch would run:
 * the first executable `claude` on the launch's `PATH`, asked
 * `claude --version`. The agent is asked once per executable, known by its
 * real path, its inode and its times of change and of status change, so
 * that a launch after the first pays a few file lookups and not a process;
 * an update of the agent is read anew.
 *
 * @param range - The tested range the version stands against.
 * @param timeoutMs - How long the agent may take to answer; ten seconds
 * when left out.
 * @returns The reader. It gives the version and its standing, that no
 * agent was found, or that the one found cannot be run (it exited with an
 * error, printed no version, or did not answer in time: it is then ended,
 * with what it started), with what it printed. It keeps no such failure.
 */
export function agentVersionReader(
  range: TestedRange,
  timeoutMs = VERSION_TIMEOUT_MS,
): (environment: Readonly<Record<string, string>>) => Promise<AgentVersion> {
  const versions = new Map<string, { readonly identity: string; readonly version: string }>();

  return async (environment) => {
    const program = await findProgram(AGENT_COMMAND, environment.PATH);
    if (program === undefined) return { found: false, command: AGENT_COMMAND };
    const file = await executableFile(program);
    let known = versions.get(file.realPath);
    if (known?.identity !== file.identity) {
      const answer = await askVersion(program, environment, timeoutMs);
      if ('failure' in answer) {
        return { found: false, command: AGENT_COMMAND, failure: answer.failure };
      }
      known = { identity: file.identity, version: answer.version };
      versions.set(file.realPath, known);
    }
    return { found: true, version: known.version, standing: standingOf(known.version, range) };
  };
}

async function executableFile(program: string): Promise<ExecutableFile> {
  const realPath = await realpath(program);
  const { ino, mtimeNs, ctimeNs } = await stat(realPath, { bigint: true });
  return { realPath, identity: `${ino}:${mtimeNs}:${ctimeNs}` };
}

async function askVersion(
  program: string,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<Answer> {
  const asked = `${AGENT_COMMAND} --version`;
  const { output, failure } = await runBounded(program, ['--version'], environment, timeoutMs);
  const version = failure === undefined ? parseVersion(output) : undefined;
  if (version !== undefined) return { version };
  return { failure: { reason: `${asked} ${failure ?? 'printed no version'}`, output } };
}

/**
 * Reads the version in what `claude --version` printed
 * (`2.1.332 (Claude Code)`, or a build's `2.1.340-beta (Claude Code)`).
 *
 * @returns The version, its suffix kept; `undefined` when the text holds none.
 */
export function parseVersion(printed: string): string | undefined {
  return VERSION.exec(printed.trim())?.[0];
}

/**
 * Stands a version against the tested range, number by number. A version
 * with a suffix is a build no test ran on: `untested`, unless its numbers
 * are older than the range.
 *
 * @param version - A version of three numbers, maybe with a suffix.
 * @param range - The tested range.
 * @returns Whether it lies within the range, after it, before it, or is
 * an untested build.
 */
export function standingOf(
  version: string,
  range: TestedRange,
): 'tested' | 'newer' | 'older' | 'untested' {
  const numbers = numbersOf(version);
  if (compare(numbers, numbersOf(range.oldest)) < 0) return 'older';
  if (numbers.join('.') !== version) return 'untested';
  if (compare(numbers, numbersOf(range.newest)) > 0) return 'newer';
  return 'tested';
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The three numbers of a version, its suffix left out. */
function numbersOf(version: string): number[] {
  return (/^\d+\.\d+\.\d+/.exec(version)?.[0] ?? '').split('.').map(Number);
}
