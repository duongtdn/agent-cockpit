import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
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
   * The temporary folder it says its scripted agent keeps everything in
   * (`… in <folder>.`); `undefined` when it named none.
   */
  temporaryRoot(): string | undefined;
  /**
   * Stops it with a signal, by default as a person does with Ctrl+C
   * (`SIGINT`), and waits for it to exit. Safe to call twice: the first
   * call's signal is the one sent.
   *
   * @param signal - The signal it is sent: `SIGHUP` as when its terminal closes.
   * @returns Its exit code.
   * @throws Error when it has not exited in time; it is then killed, and
   * what its scripted agent left (its tmux servers, its temporary folder) removed.
   */
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

/** How an example that ran to its end ended. */
export interface ExampleExit {
  /** Its exit code. */
  readonly code: number | null;
  /** Everything it printed, its errors included. */
  readonly printed: string;
  /** The temporary folder it said its scripted agent keeps everything in; `undefined` when it named none. */
  readonly temporaryRoot: string | undefined;
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
  const child = startChild(name, args);
  let output = '';
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  const link = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      void killAndClean(child, output).finally(() =>
        reject(new Error(`The example printed no link in time:\n${output}`)),
      );
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
    temporaryRoot: () => temporaryRootIn(output),
    stop: (signal = 'SIGINT') => {
      stopped ??= stopChild(child, signal, exited, () => output);
      return stopped;
    },
  };
}

/**
 * Runs an example of `examples/` that is expected to end by itself, such as
 * one that cannot start, and waits for it to exit.
 *
 * @param name - The example's folder in `examples/`.
 * @param args - Its command-line arguments.
 * @returns How it ended.
 * @throws Error when it has not exited in time; it is then killed, and what
 * its scripted agent left removed.
 */
export function runExampleToItsEnd(name: string, args: readonly string[]): Promise<ExampleExit> {
  return runToItsEnd(name, args, () => {});
}

/**
 * Runs an example of `examples/` and sends it a signal while it starts: as
 * soon as it names its scripted agent's temporary folder, before it prints
 * its link — while it opens the cockpit and its server. Waits for it to exit.
 *
 * @param name - The example's folder in `examples/`.
 * @param args - Its command-line arguments.
 * @param signal - The signal it is sent, as a person's Ctrl+C (`SIGINT`) or a closed terminal (`SIGHUP`).
 * @returns How it ended.
 * @throws Error when it has not exited in time; it is then killed, and what
 * its scripted agent left removed.
 */
export function interruptExampleWhileStarting(
  name: string,
  args: readonly string[],
  signal: NodeJS.Signals,
): Promise<ExampleExit> {
  let sent = false;
  return runToItsEnd(name, args, (output, child) => {
    if (sent || temporaryRootIn(output) === undefined) return;
    sent = true;
    child.kill(signal);
  });
}

async function runToItsEnd(
  name: string,
  args: readonly string[],
  onOutput: (output: string, child: ChildProcess) => void,
): Promise<ExampleExit> {
  const child = startChild(name, args);
  let output = '';
  const take = (chunk: Buffer) => {
    output += chunk;
    onOutput(output, child);
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  const code = await withinPatience(child, exited, () => output, 'did not end');
  return { code, printed: output, temporaryRoot: temporaryRootIn(output) };
}

/** The folder the scripted agent's description names: `…, in <folder>.` */
function temporaryRootIn(printed: string): string | undefined {
  return /fake API, in (\S+)\.$/m.exec(printed)?.[1];
}

function startChild(name: string, args: readonly string[]): ChildProcess {
  return spawn(process.execPath, [`examples/${name}/server.js`, ...args], {
    cwd: repository,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  exited: Promise<number | null>,
  output: () => string,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  child.kill(signal);
  return withinPatience(child, exited, output, 'did not stop');
}

/** Waits for the example to exit; one that takes too long is killed, and what it left removed. */
async function withinPatience(
  child: ChildProcess,
  exited: Promise<number | null>,
  output: () => string,
  failure: string,
): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void killAndClean(child, output()).finally(() =>
        reject(new Error(`The example ${failure} in time:\n${output()}`)),
      );
    }, PATIENCE_MS);
  });
  try {
    return await Promise.race([exited, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kills the example, which then cleans nothing up, and removes what its
 * scripted agent left: the tmux servers of its sockets (their sessions, the
 * agents) and its temporary folder.
 */
async function killAndClean(child: ChildProcess, output: string): Promise<void> {
  child.kill('SIGKILL');
  const root = temporaryRootIn(output);
  if (root === undefined) return;
  for (const socket of socketsUnder(join(root, 'tmux'))) {
    try {
      execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // Its server is gone already.
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

/** The tmux sockets under a `TMUX_TMPDIR`: tmux keeps them in a folder per user, `tmux-<uid>`. */
function socketsUnder(tmuxFolder: string): string[] {
  if (!existsSync(tmuxFolder)) return [];
  return readdirSync(tmuxFolder).flatMap((userFolder) =>
    readdirSync(join(tmuxFolder, userFolder)).map((socket) => join(tmuxFolder, userFolder, socket)),
  );
}
