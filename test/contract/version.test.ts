import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { pinnedAgentVersion } from '../support/real-agent/binary.ts';
import { startContractCockpit } from './cockpit-harness.ts';

/** The agent's version, as the driver reads it before each launch. */

const run = promisify(execFile);

it('84 — claude --version prints <x.y.z> (Claude Code) and a line break, and exits 0, with no dialog and no hook, whatever its configuration lacks', async () => {
  const cockpit = await startContractCockpit({
    shim: { leftOutOfRecipe: ['onboarding', 'folder-trust', 'key-approval'] },
  });
  const untrusted = join(cockpit.root, 'untrusted');
  mkdirSync(untrusted);

  const printed = await run(join(cockpit.root, 'bin', 'claude'), ['--version'], {
    cwd: untrusted,
    env: { PATH: cockpit.serverPath },
  });
  const read = await claudeCode().agentVersion({ PATH: cockpit.serverPath });

  expect(printed).toEqual({ stdout: `${pinnedAgentVersion()} (Claude Code)\n`, stderr: '' });
  expect(printed.stdout).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)\n$/);
  expect(read).toMatchObject({ found: true, version: pinnedAgentVersion() });
  expect(cockpit.cockpit.status()).toMatchObject({
    agentVersion: pinnedAgentVersion(),
    tested: true,
  });
  expect(cockpit.hooksRead).toEqual([]);
  expect(cockpit.launches).toEqual([]);
});
