import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { connectionArguments } from './tmux-commands.js';
import { classifyFailure, type TmuxFailureKind } from './tmux-replies.js';

/** A tmux command that failed, or tmux itself that could not be run. */
export class TmuxFailure extends Error {
  override readonly name = 'TmuxFailure';
  /** What the failure means to the host; `not-installed` when tmux could not be run. */
  readonly kind: TmuxFailureKind | 'not-installed';

  /**
   * @param kind - What the failure means to the host.
   * @param message - What tmux, or the system, said.
   * @param cause - The error of the child process.
   */
  constructor(kind: TmuxFailureKind | 'not-installed', message: string, cause: unknown) {
    super(message, { cause });
    this.kind = kind;
  }
}

/** Runs tmux commands on one socket. */
export interface TmuxClient {
  /**
   * Runs one tmux call on the app's socket.
   *
   * @param args - The command and its arguments; several commands are
   * separated by a `;` argument.
   * @returns What the call printed.
   * @throws {@link TmuxFailure} when the call fails, or takes too long.
   */
  run(args: readonly string[]): Promise<string>;
  /**
   * Runs one tmux call that prints, then reads what is written from what it
   * printed: its standard input stays open until it has printed a line that
   * is the marker.
   *
   * The call runs without a `PATH`: tmux gives a pane the `PATH` of the
   * client that starts its session, over the one the commands name.
   *
   * @param args - The command and its arguments.
   * @param marker - The line that ends what the answer is written from.
   * @param answer - Given what the call printed before the marker, returns
   * what it reads on its standard input.
   * @returns What the call printed.
   * @throws {@link TmuxFailure} when the call fails, or takes too long; what
   * `answer` throws, the call then ended.
   */
  runAnswering(
    args: readonly string[],
    marker: string,
    answer: (printed: string) => string,
  ): Promise<string>;
  /**
   * Asks tmux for its version; it needs no server.
   *
   * @returns What `tmux -V` printed.
   * @throws {@link TmuxFailure} when tmux cannot be run.
   */
  version(): Promise<string>;
  /** The tmux program the client runs. */
  readonly executable: string;
  /** The arguments a call on the app's socket begins with. */
  readonly connection: readonly string[];
  /**
   * The environment tmux runs in: the calling process's as it is now,
   * without the variables that would tie a call to a tmux session the
   * process itself was started in.
   */
  environment(): NodeJS.ProcessEnv;
}

/** tmux prints a server's whole environment, and a screen: more than Node keeps by default. */
const MOST_OUTPUT_BYTES = 64 * 1024 * 1024;

function tmuxEnvironment(): NodeJS.ProcessEnv {
  const { TMUX: _session, TMUX_PANE: _pane, ...environment } = process.env;
  return environment;
}

/** What a failed child process tells; `killed` when Node ended it for taking too long. */
type ChildError = Error & { code?: unknown; killed?: boolean };

function failureOf(error: ChildError, stderr: string, timeoutMs: number): TmuxFailure {
  if (error.code === 'ENOENT') return new TmuxFailure('not-installed', error.message, error);
  if (error.killed === true) {
    return new TmuxFailure('other', `no answer within ${timeoutMs} ms`, error);
  }
  return new TmuxFailure(classifyFailure(stderr), stderr.trim() || error.message, error);
}

/** One run of a program: what it runs in, and what it is given to read. */
interface Execution {
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /**
   * Writes the program's standard input and ends it, at once or from what it
   * prints; `abandon` ends the run with an error when it cannot.
   */
  readonly feed: (child: ReturnType<typeof execFile>, abandon: (error: unknown) => void) => void;
}

function execute(executable: string, args: readonly string[], execution: Execution) {
  const { environment, timeoutMs, feed } = execution;
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { env: environment, timeout: timeoutMs, maxBuffer: MOST_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(failureOf(error, stderr, timeoutMs));
      },
    );
    // A tmux that could not be started, or that ended early, has no input to
    // take; its error is the one reported above.
    child.stdin?.on('error', () => {});
    feed(child, (error) => {
      // The run fails with this error; what the ended program then reports is not heard.
      reject(error);
      child.kill();
    });
  });
}

function feedNothing(child: ReturnType<typeof execFile>): void {
  child.stdin?.end();
}

/** Feeds a program, once it has printed the marker's line, the answer to what came before. */
function feedAnswer(marker: string, answer: (printed: string) => string): Execution['feed'] {
  const end = `${marker}\n`;
  return (child, abandon) => {
    let printed = '';
    let answered = false;
    child.stdout?.on('data', (data: string) => {
      printed += data;
      if (answered || !(printed === end || printed.endsWith(`\n${end}`))) return;
      answered = true;
      try {
        child.stdin?.end(answer(printed.slice(0, -end.length)));
      } catch (error) {
        // Thrown from a listener, it would end the whole process, uncaught.
        abandon(error);
      }
    });
  };
}

/**
 * Finds a program as the system would, in the folders of a `PATH`: for a
 * call that itself runs without one.
 *
 * An empty entry of the `PATH` is skipped. POSIX reads it as the current
 * folder; the host does not, so that a file named `tmux` in whatever folder
 * the app runs in is never taken for the program.
 *
 * @returns The program's path; the name as it is when it is a path already,
 * or when no folder has it.
 */
async function findProgram(program: string, path: string | undefined): Promise<string> {
  if (program.includes('/')) return program;
  for (const folder of (path ?? '').split(delimiter).filter((entry) => entry !== '')) {
    const candidate = join(folder, program);
    const runs = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (runs) return candidate;
  }
  return program;
}

/**
 * Creates the client of an app's tmux server.
 *
 * @param socketName - The name of the app's socket.
 * @param executable - The tmux program to run.
 * @param timeoutMs - How long a call may take before it is ended and fails.
 */
export function createTmuxClient(
  socketName: string,
  executable: string,
  timeoutMs: number,
): TmuxClient {
  const connection = connectionArguments(socketName);
  return {
    run: (args) =>
      execute(executable, [...connection, ...args], {
        environment: tmuxEnvironment(),
        timeoutMs,
        feed: feedNothing,
      }),
    async runAnswering(args, marker, answer) {
      const { PATH: path, ...environment } = tmuxEnvironment();
      return execute(await findProgram(executable, path), [...connection, ...args], {
        environment,
        timeoutMs,
        feed: feedAnswer(marker, answer),
      });
    },
    version: () =>
      execute(executable, ['-V'], {
        environment: tmuxEnvironment(),
        timeoutMs,
        feed: feedNothing,
      }),
    executable,
    connection,
    environment: tmuxEnvironment,
  };
}
