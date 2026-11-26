import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

/** How long an example may take to print its link, or to stop, before the test fails saying what it printed. */
const PATIENCE_MS = 20_000;

/** An example app running as a person starts it, in a process of its own. */
export interface ExampleApp {
  /** The link it printed for the person to open: the page's URL, the app's token in its fragment. */
  readonly link: string;
  /** Everything it printed so far, its errors included. */
  printed(): string;
  /**
   * Stops it as a person does, with Ctrl+C (`SIGINT`), and waits for it to
   * exit. Safe to call twice.
   *
   * @returns Its exit code.
   * @throws Error when it has not exited in time; it is then killed.
   */
  stop(): Promise<number | null>;
}

/**
 * Starts an example of `examples/` with Node, from the repository's folder,
 * and waits for the line where it prints its link (`Open <url>`). The
 * example imports the built package: `pnpm build` first.
 *
 * @param name - The example's folder in `examples/`.
 * @param args - Its command-line arguments.
 * @returns The running example; the caller stops it.
 * @throws Error, with what it printed, when it exits or takes too long before printing its link.
 */
export async function startExampleApp(name: string, args: readonly string[]): Promise<ExampleApp> {
  const child = spawn(process.execPath, [`examples/${name}/server.js`, ...args], {
    cwd: repository,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  const link = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The example printed no link in time:\n${output}`));
    }, PATIENCE_MS);
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
      output += `${line}\n`;
      const printed = /^Open (\S+)$/.exec(line)?.[1];
      if (printed === undefined) return;
      clearTimeout(timer);
      resolve(printed);
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`The example exited (${code}) before printing its link:\n${output}`));
    });
  });
  let stopped: Promise<number | null> | undefined;
  return {
    link,
    printed: () => output,
    stop: () => {
      stopped ??= stopChild(child, exited, () => output);
      return stopped;
    },
  };
}

async function stopChild(
  child: ChildProcess,
  exited: Promise<number | null>,
  output: () => string,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  child.kill('SIGINT');
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The example did not stop in time:\n${output()}`));
    }, PATIENCE_MS);
  });
  try {
    return await Promise.race([exited, late]);
  } finally {
    clearTimeout(timer);
  }
}
