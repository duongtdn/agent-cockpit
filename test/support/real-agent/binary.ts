import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The package the pinned agent is installed from, as a development dependency. */
const AGENT_PACKAGE = '@anthropic-ai/claude-code';

/**
 * Finds the agent the repository pins: the binary of the installed package,
 * never a `claude` of the `PATH`, which is the person's own and of any version.
 *
 * @returns The binary's absolute path.
 */
export function pinnedAgentBinary(): string {
  const manifestPath = createRequire(import.meta.url).resolve(`${AGENT_PACKAGE}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: { claude: string } };
  return join(dirname(manifestPath), manifest.bin.claude);
}

/**
 * Asks the pinned agent its version (`--version`), which starts no session
 * and calls no one.
 *
 * @returns The version, such as `2.1.332`.
 * @throws Error when the binary does not run (its package's install script
 * was not allowed to) or prints no version.
 */
export function pinnedAgentVersion(): string {
  const printed = execFileSync(pinnedAgentBinary(), ['--version'], {
    encoding: 'utf8',
    // Nothing of the person's: not their configuration folder, not their keys.
    env: { PATH: '/usr/bin:/bin' },
  });
  const [version] = /^\d+\.\d+\.\d+\S*/.exec(printed.trim()) ?? [];
  if (version === undefined) throw new Error(`The pinned agent printed no version: ${printed}`);
  return version;
}

/** How the agent's program begins the list of its hook events, wherever it writes it. */
const HOOK_EVENTS_START = '["PreToolUse","PostToolUse",';

/**
 * Reads the hook events the pinned agent has from its own program, which
 * holds their names as a list: what its settings accept under `hooks`.
 *
 * @returns The names, each once.
 * @throws Error when the program holds no such list: it is written another
 * way in this version, and the list is to be found again.
 */
export function pinnedAgentHookEvents(): string[] {
  const program = readFileSync(pinnedAgentBinary());
  const events = new Set<string>();
  let start = program.indexOf(HOOK_EVENTS_START);
  while (start !== -1) {
    const end = program.indexOf(']', start);
    for (const event of JSON.parse(program.toString('utf8', start, end + 1)) as string[]) {
      events.add(event);
    }
    start = program.indexOf(HOOK_EVENTS_START, end);
  }
  if (events.size === 0) throw new Error('The pinned agent holds no list of its hook events.');
  return [...events];
}
