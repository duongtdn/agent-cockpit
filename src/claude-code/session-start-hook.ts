/**
 * Claude Code's `SessionStart` hook: a program of its own, which the agent
 * runs as a command hook, since it never posts that event as an HTTP hook.
 * Its command line is `<node> <this file> <address file>`; its input, the
 * hook's payload. It reads the session's hook address and token from that
 * file, in the session's folder, and posts the payload there, as the HTTP
 * hooks do: the token is never on its command line nor in its environment.
 *
 * It imports nothing of the package's but types, so that Node runs it as it
 * is: the built JavaScript on any Node the package supports, and this source
 * on a Node that strips types, in the package's own tests.
 *
 * @packageDocumentation
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { HookAddress } from '../server/driver.js';

/**
 * How long the report may take. The listener is local and answers at once;
 * a hook that hangs would hold the agent's start for its own timeout.
 */
const REPORT_TIMEOUT_MS = 10_000;

/**
 * Posts a `SessionStart` payload to the session's hook address, with its token.
 *
 * @param addressFile - The file that holds the session's {@link HookAddress}
 * as JSON, its URL the hooks' own.
 * @param payload - The hook's payload, as the agent gave it.
 * @throws `Error` when the address cannot be read, the listener cannot be
 * reached in time, or answers with a status that is no success.
 */
export async function reportSessionStart(addressFile: string, payload: string): Promise<void> {
  const address = JSON.parse(await readFile(addressFile, 'utf8')) as HookAddress;
  const response = await fetch(address.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${address.token}`, 'content-type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`the cockpit answered ${response.status}`);
}

async function readInput(): Promise<string> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/**
 * Reports, and prints nothing: what a `SessionStart` hook prints is added to
 * the agent's context. A failure exits 1, which the agent shows as a failed
 * hook in its terminal, as it does for an HTTP hook that cannot reach the
 * cockpit.
 */
async function main(addressFile: string | undefined): Promise<void> {
  try {
    if (addressFile === undefined) throw new Error('no address file was given');
    await reportSessionStart(addressFile, await readInput());
  } catch (error) {
    process.stderr.write(`agent-cockpit: SessionStart not reported: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

/** Whether Node runs this file as its program, rather than a test importing it. */
function isRunAsProgram(): boolean {
  const program = process.argv[1];
  try {
    return program !== undefined && realpathSync(program) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isRunAsProgram()) await main(process.argv[2]);
