import { realpath } from 'node:fs/promises';
import { CockpitError } from '../shared/cockpit-error.js';
import { runBounded } from './bounded-run.js';
import { findProgram } from './launching.js';

/**
 * The programs the agent's sandbox needs, by platform: on Linux,
 * bubblewrap and socat, found on the agent's `PATH`. Without one the agent
 * starts, then exits with nothing on its screen to say why, so the driver
 * looks first. Elsewhere the agent's own refusal (`failIfUnavailable`) is
 * the check.
 */
const SANDBOX_PROGRAMS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  linux: ['bwrap', 'socat'],
};

/**
 * What `bwrap` is asked to make, as the agent's sandbox does: every
 * namespace, then, inside them, a user namespace of its own, as the
 * agent's seccomp helper makes one and needs its capabilities there. A
 * `bwrap` that AppArmor confines (Ubuntu 24.04's `bwrap-userns-restrict`)
 * makes the first and is refused the second: the agent then starts and
 * exits at once, its sandbox unavailable, with nothing to tell why.
 */
const PROBE_ARGUMENTS: readonly string[] = [
  '--unshare-all',
  '--die-with-parent',
  '--ro-bind',
  '/',
  '/',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  'unshare',
  '--user',
  '--map-root-user',
  'true',
];

/**
 * How long the probe may take. `bwrap` makes its namespaces in a few
 * milliseconds; ten seconds, as for the agent's version, only bounds one
 * that hangs, well before the request that launches gives up.
 */
const PROBE_TIMEOUT_MS = 10_000;

const WHAT_TO_INSTALL =
  'the sandbox needs bubblewrap (bwrap) and socat (on Debian or Ubuntu: apt install bubblewrap socat).';

const WHAT_TO_ALLOW =
  'The sandbox makes a user namespace inside bwrap’s: let unprivileged user namespaces be made, ' +
  'nested ones too (on Ubuntu 24.04 and later, AppArmor restricts them: sysctl ' +
  'kernel.apparmor_restrict_unprivileged_userns=0, and unload the bwrap-userns-restrict profile ' +
  'where it is loaded), and keep util-linux’s unshare on the PATH for this check.';

/**
 * Creates the check, before each launch whose app asks for the sandbox,
 * that the agent's sandbox can run: its programs on the launch's `PATH`,
 * then, on Linux, one probe of what `bwrap` must make. A probe that passed
 * is kept for the `bwrap` it ran (by its real path), so a driver — one per
 * cockpit — probes once; one that failed is not, so a launch after the
 * machine is fixed runs.
 *
 * @param timeoutMs - How long the probe may take; ten seconds when left out.
 * @returns The check. It rejects with `CockpitError` `sandbox-unavailable`
 * (`cause`: what is missing, or what `bwrap` said, and what would fix it)
 * where the sandbox cannot run.
 */
export function sandboxChecker(
  timeoutMs = PROBE_TIMEOUT_MS,
): (environment: Readonly<Record<string, string>>) => Promise<void> {
  const probed = new Set<string>();

  return async (environment) => {
    const programs = SANDBOX_PROGRAMS[process.platform] ?? [];
    const found = await Promise.all(programs.map((name) => findProgram(name, environment.PATH)));
    const missing = programs.filter((_, index) => found[index] === undefined);
    if (missing.length > 0) {
      throw unavailable(
        `${missing.join(' and ')} not found on the PATH the agent is launched with; ${WHAT_TO_INSTALL}`,
      );
    }
    const bwrap = found[programs.indexOf('bwrap')];
    if (bwrap === undefined) return;
    const program = await realpath(bwrap);
    if (probed.has(program)) return;
    const { failure, output } = await runBounded(bwrap, PROBE_ARGUMENTS, environment, timeoutMs);
    if (failure !== undefined) {
      const said = output.trim() === '' ? '' : `: ${output.trim()}`;
      throw unavailable(`bwrap ${PROBE_ARGUMENTS.join(' ')} ${failure}${said}. ${WHAT_TO_ALLOW}`);
    }
    probed.add(program);
  };
}

function unavailable(cause: string): CockpitError {
  return new CockpitError(
    'sandbox-unavailable',
    "The app asked for Claude Code's sandbox, which cannot run here: the session is not started.",
    { cause },
  );
}
