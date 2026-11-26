import { execFileSync } from 'node:child_process';

/**
 * Whether the agent's sandbox can run here, for the rows that turn it on.
 * Where it cannot, those rows fail with the problem, on every platform: they
 * are never left out.
 */
export type SandboxStatus =
  | { readonly kind: 'available' }
  /** It cannot run: the rows fail with the problem. */
  | { readonly kind: 'missing'; readonly problem: string };

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
 * @param probe - What tries the sandbox's programs; this machine's by default.
 * @returns The status: available, or missing with why and what would fix it.
 */
export function sandboxStatus(probe: SandboxProbe = probeTheSandbox): SandboxStatus {
  const problem = probe();
  if (problem === undefined) return { kind: 'available' };
  return {
    kind: 'missing',
    problem:
      `The agent's sandbox cannot run here: ${problem}. Install bubblewrap and socat, and let ` +
      'unprivileged user namespaces be made (on Ubuntu 24.04: sysctl ' +
      'kernel.apparmor_restrict_unprivileged_userns=0).',
  };
}
