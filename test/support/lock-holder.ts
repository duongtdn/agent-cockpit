// A process of an app that takes the app's lock, for the lock's tests:
// `node --import run-source.mjs lock-holder.ts <folder> <waitMs> <mode>`.
// It prints `READY` (mode `on-go`, then waits for a line `go`), then
// `HELD <pid>` or `LOCKED <holder>`. Holding, it takes lines: `release`
// (prints `RELEASED`), `exit`. In mode `return` it reads nothing once it
// holds the lock, so that the process ends unless the lock keeps it alive.
import { createInterface } from 'node:readline';
import { takeAppLock } from '../../src/server/state/lock.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

const [folder, waitMs, mode] = process.argv.slice(2) as [
  string,
  string,
  'now' | 'on-go' | 'return',
];
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();

if (mode === 'on-go') {
  console.log('READY');
  await lines.next();
}

try {
  const lock = await takeAppLock(folder, { waitMs: Number(waitMs) });
  console.log(`HELD ${process.pid}`);
  if (mode === 'return') {
    input.close();
  } else {
    for await (const line of lines) {
      if (line === 'release') {
        await lock.release();
        console.log('RELEASED');
      }
      if (line === 'exit') process.exit(0);
    }
  }
} catch (error) {
  if (!isCockpitError(error, 'cockpit-locked')) throw error;
  console.log(`LOCKED ${error.holder}`);
  process.exit(0);
}
