import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The variable a test sets for the fake agent to say another version than
 * the pinned agent's: one newer or older than the tested range.
 */
export const VERSION_VARIABLE = 'FAKE_AGENT_VERSION';

/** The package the pinned agent is installed from. */
const AGENT_PACKAGE = '@anthropic-ai/claude-code';

/**
 * Gives the version the fake agent says it is: the test's, or the pinned
 * agent's, whose package and binary carry the same.
 *
 * @param environment - The fake agent's environment.
 */
export function fakeAgentVersion(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return environment[VERSION_VARIABLE] ?? pinnedPackageVersion();
}

function pinnedPackageVersion(): string {
  const manifest = createRequire(import.meta.url).resolve(`${AGENT_PACKAGE}/package.json`);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}

/**
 * What Claude Code prints for `--version`, seen of 2.1.332: the version,
 * then its name, on one line.
 *
 * @param version - The version.
 * @returns The output, its line break included.
 */
export function versionOutput(version: string): string {
  return `${version} (Claude Code)\n`;
}
