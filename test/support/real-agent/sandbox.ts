import { execFileSync } from 'node:child_process';

/**
 * The variable by which CI, and only CI, says that its platform cannot run
 * the agent's sandbox, and why. A run where the sandbox cannot run and
 * nothing says so fails the sandbox's rows, so that they are never skipped
 * unseen; a run where CI says so leaves them out, and its results say why.
 */
export const SANDBOX_LACKING_VARIABLE = 'COCKPIT_CONTRACT_SANDBOX_LACKING';

/** Whether the agent's sandbox can run here, for the rows that turn it on. */
export type SandboxStatus =
  | { readonly kind: 'available' }
  /** It cannot run and nothing says the platform lacks it: the rows fail with the problem. */
  | { readonly kind: 'missing'; readonly problem: string }
  /** It cannot run, and CI says its platform lacks it: the rows do not run, and the results say why. */
  | { readonly kind: 'declared-lacking'; readonly reason: string; readonly problem: string };

/** Tells why the sandbox cannot run, or nothing when it can. */
export type SandboxProbe = () => string | undefined;

/**
 * The programs the agent's sandbox needs on Linux, found where the agent
 * looks for them (its `PATH`), and a namespace `bwrap` can make.
 */
export const probeTheSandbox: SandboxProbe = () => {
  const path = '/usr/local/bin:/usr/bin:/bin';
  const checks: [string, string[]][] = [
    ['socat', ['-V']],
    ['bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', 'true']],
  ];
  for (const [program, args] of checks) {
    try {
      execFileSync(program, args, { env: { PATH: path }, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
      return `${program} ${args.join(' ')} failed: ${stderr || (error as Error).message}`;
    }
  }
  return undefined;
};

/**
 * Tells whether the agent's sandbox can run here.
 *
 * @param variables - The process's environment.
 * @param probe - What tries the sandbox's programs; this machine's by default.
 * @returns The status: available; declared lacking, only when `CI` is
 * `true` and {@link SANDBOX_LACKING_VARIABLE} gives a reason; else missing.
 */
export function sandboxStatus(
  variables: Readonly<Record<string, string | undefined>> = process.env,
  probe: SandboxProbe = probeTheSandbox,
): SandboxStatus {
  const problem = probe();
  if (problem === undefined) return { kind: 'available' };
  const reason = variables[SANDBOX_LACKING_VARIABLE];
  if (variables.CI === 'true' && reason !== undefined && reason !== '') {
    return { kind: 'declared-lacking', reason, problem };
  }
  return {
    kind: 'missing',
    problem:
      `The agent's sandbox cannot run here: ${problem}. Install bubblewrap and socat, and let ` +
      'unprivileged user namespaces be made (on Ubuntu 24.04: sysctl ' +
      'kernel.apparmor_restrict_unprivileged_userns=0). Only CI may say that its platform ' +
      `lacks the sandbox, by ${SANDBOX_LACKING_VARIABLE}=<why> with CI=true.`,
  };
}
