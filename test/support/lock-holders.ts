import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const SCRIPT = new URL('./lock-holder.ts', import.meta.url).pathname;
const RUN_SOURCE = new URL('./run-source.mjs', import.meta.url).pathname;

/** A process of an app that takes the app's lock (`lock-holder.ts`). */
export interface LockHolder {
  readonly pid: number;
  /** The next line it prints. */
  nextLine(): Promise<string>;
  /** Sends it a line. */
  send(line: string): void;
  /** Resolves with its exit code once it has exited. */
  readonly exited: Promise<number | null>;
  readonly process: ChildProcessWithoutNullStreams;
}

const started = new Set<ChildProcessWithoutNullStreams>();

/**
 * Starts a process that takes the lock of a state folder.
 *
 * @param mode - `now`: tries at once; `on-go`: prints `READY` and tries on
 * the line `go`; `return`: tries at once, then reads nothing more.
 */
export function startLockHolder(
  folder: string,
  { waitMs = 0, mode = 'now' }: { waitMs?: number; mode?: 'now' | 'on-go' | 'return' } = {},
): LockHolder {
  const child = spawn(process.execPath, [
    '--import',
    RUN_SOURCE,
    SCRIPT,
    folder,
    String(waitMs),
    mode,
  ]);
  started.add(child);
  const exited = once(child, 'exit').then(([code]) => {
    started.delete(child);
    return code as number | null;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  return {
    pid: child.pid as number,
    process: child,
    exited,
    async nextLine() {
      const { value, done } = await lines.next();
      if (done) throw new Error(`The lock holder ended without a line. ${errors}`);
      return value;
    },
    send(line) {
      child.stdin.write(`${line}\n`);
    },
  };
}

/** Kills every lock holder still running, and waits for each to exit. */
export async function killLockHolders(): Promise<void> {
  await Promise.all(
    [...started].map((child) => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      return exited;
    }),
  );
}
