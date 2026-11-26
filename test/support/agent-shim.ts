import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellWord } from '../../src/claude-code/launching.ts';
import type { AgentCommand } from './fake-agent/launching.ts';

/**
 * Puts a `claude` in a folder that runs the test's agent instead, with the
 * arguments the driver gave: a test puts the folder first on the session's
 * `PATH`, and the driver launches the test's agent with no option of its
 * own for it.
 *
 * @param folder - An existing folder of the test's own.
 * @param agent - The agent's program and the arguments that come before the driver's.
 * @returns The folder, to put first on the `PATH`.
 */
export function writeAgentShim(folder: string, agent: AgentCommand): string {
  const shim = join(folder, 'claude');
  const command = [agent.command, ...agent.args].map(shellWord).join(' ');
  writeFileSync(shim, `#!/bin/sh\nexec ${command} "$@"\n`);
  chmodSync(shim, 0o700);
  return folder;
}
