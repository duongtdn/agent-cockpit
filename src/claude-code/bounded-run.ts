import { spawn } from 'node:child_process';

/** The most of what a program printed a run keeps: enough for an error's first lines. */
const MOST_OUTPUT_CHARACTERS = 4096;

/** What a bounded run of a program gave. */
export interface BoundedRun {
  /** What it printed, its output and its errors together, cut to a few kilobytes. */
  readonly output: string;
  /**
   * Why it failed, in words that follow the command's (`exited with status
   * 1`, `did not answer within 10 s`); absent when it exited with status 0.
   */
  readonly failure?: string;
}

/**
 * Runs a program the driver asks something of before a launch (the agent's
 * version, the sandbox's probe), for a bounded time. It runs in a process
 * group of its own, so that on a timeout it and whatever it started are
 * ended together, and the answer never waits on a child still holding its
 * output.
 *
 * @param program - The program's path.
 * @param args - Its arguments.
 * @param environment - Its whole environment.
 * @param timeoutMs - How long it may take.
 * @returns What it printed, and why it failed when it did; it never rejects.
 */
export function runBounded(
  program: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<BoundedRun> {
  return new Promise((resolve) => {
    let output = '';
    const settle = (failure?: string) => {
      clearTimeout(timer);
      resolve({ output: cut(output), ...(failure === undefined ? {} : { failure }) });
    };
    const child = spawn(program, args, {
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      endGroup(child.pid);
      settle(`did not answer within ${timeoutMs / 1000} s`);
    }, timeoutMs);
    const read = (chunk: Buffer) => {
      if (output.length <= MOST_OUTPUT_CHARACTERS) output += chunk.toString('utf8');
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (error) => settle(`could not be started: ${error.message}`));
    child.on('close', (status, signal) => {
      if (status === 0) settle();
      else settle(status === null ? `ended by ${signal}` : `exited with status ${status}`);
    });
  });
}

function endGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Gone already.
  }
}

function cut(output: string): string {
  return output.length <= MOST_OUTPUT_CHARACTERS
    ? output
    : `${output.slice(0, MOST_OUTPUT_CHARACTERS)}…`;
}
