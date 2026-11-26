import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, vi } from 'vitest';
import type { LaunchCommand } from '../../src/server/driver.ts';
import { toolUse, turn } from '../support/fake-api/index.ts';
import { type HookPayload, SAID_KEY, startContractCockpit } from './cockpit-harness.ts';
import { itInTheSandbox } from './confinement-probes.ts';

/**
 * The app's `sandbox` option, through the driver's own settings, on the
 * real agent: it turns the sandbox on and refuses to run without it, never
 * running a session unsandboxed instead.
 */

/** The folders whose programs a session's `PATH` holds. */
const PROGRAM_FOLDERS = ['/usr/bin', '/bin'];

/**
 * Makes a folder of links to every program of the machine's but bubblewrap,
 * which the sandbox needs: a `PATH` of it is a machine where the sandbox
 * cannot run. Removed with the test.
 */
function programsWithoutBwrap(): string {
  const folder = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-no-bwrap-'));
  onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
  const linked = new Set<string>();
  for (const programs of PROGRAM_FOLDERS) {
    for (const name of readdirSync(programs)) {
      if (name === 'bwrap' || linked.has(name)) continue;
      symlinkSync(join(programs, name), join(folder, name));
      linked.add(name);
    }
  }
  return folder;
}

function sandboxOf(launch: LaunchCommand | undefined): unknown {
  const args = launch?.args ?? [];
  return JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8')).sandbox;
}

itInTheSandbox(
  "90 — The app's sandbox is written on, with failIfUnavailable: where the agent finds no bwrap it fires SessionStart, then exits with SessionEnd (reason other), its launch prompt never sent and no command run; where the driver finds none, it refuses the launch (sandbox-unavailable) and nothing starts",
  async () => {
    const noBwrap = programsWithoutBwrap();
    const cockpit = await startContractCockpit({
      driver: { sandbox: true, permissions: { allow: ['Bash'] } },
      // The agent's PATH lacks bwrap, the server's has it: the driver's own check passes.
      shim: { variables: { PATH: noBwrap } },
    });
    cockpit.api.script(
      turn(toolUse('Bash', { command: 'touch ran-unsandboxed', description: 'a probe' })),
      turn('Ran.'),
    );

    const run = await cockpit.say('run the probe');
    const ended = await cockpit.sessionIn(SAID_KEY, 'ended');
    const hooks = cockpit.hooksRead.map((request) => request.body as HookPayload);
    // Now the server's PATH lacks it too: the shim first, then the same programs.
    const [shimFolder] = cockpit.serverPath.split(':');
    vi.stubEnv('PATH', `${shimFolder}:${noBwrap}`);
    const refused = cockpit.say('run the probe', 'refused');

    expect(sandboxOf(cockpit.launches[0])).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    expect(hooks.map((hook) => hook.hook_event_name)).toEqual(['SessionStart', 'SessionEnd']);
    expect(hooks[1]).toMatchObject({ reason: 'other' });
    // Nothing tells the cockpit why: the agent's end reads as any other it did not ask for.
    expect(run).toEqual({ action: 'started', state: 'ended' });
    expect(ended).toMatchObject({ state: 'ended', reason: 'lost', canResume: false });
    expect(cockpit.api.requests().filter((request) => request.kind === 'conversation')).toEqual([]);
    expect(existsSync(join(cockpit.workFolder, 'ran-unsandboxed'))).toBe(false);
    await expect(refused).rejects.toMatchObject({
      code: 'sandbox-unavailable',
      cause: expect.stringContaining('bwrap'),
    });
    expect(cockpit.launches).toHaveLength(1);
    expect(cockpit.cockpit.sessions.list().map((session) => session.key)).toEqual([SAID_KEY]);
  },
);
