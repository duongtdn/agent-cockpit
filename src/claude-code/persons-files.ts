import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { givenAndRealPaths, holdsRuleSyntax } from '../server/confinement.js';
import type { Issue } from '../shared/cockpit-error.js';
import { agentConfigFolder } from './conversations.js';

/** The person's own files and folders that start code at the agent's next launch. */
export interface PersonsStartUpFiles {
  /**
   * Their settings (`<config>/settings.json`: hooks) and configuration
   * files (`<config>/.claude.json`, `~/.claude.json`: MCP servers), each by
   * the path the agent reads it at and by its real path.
   */
  readonly personsFiles: readonly string[];
  /** Their plugins' folder (`<config>/plugins`), by both paths. */
  readonly personsFolders: readonly string[];
}

/** A folder of the person's the denies name, and the variable that names it. */
interface PersonsFolder {
  readonly variable: string;
  readonly path: string;
}

/**
 * The person's folders, as the agent of a launch with this environment
 * finds them: its configuration folder (`CLAUDE_CONFIG_DIR`, else
 * `.claude` in the home) and its home.
 */
function personsFolders(environment: Readonly<Record<string, string>>): {
  readonly config: PersonsFolder;
  readonly home: PersonsFolder;
} {
  const configured = environment.CLAUDE_CONFIG_DIR;
  const named = configured !== undefined && configured !== '';
  return {
    config: {
      variable: named ? 'CLAUDE_CONFIG_DIR' : 'HOME',
      path: agentConfigFolder(environment),
    },
    home: { variable: 'HOME', path: homeOf(environment) },
  };
}

function homeOf(environment: Readonly<Record<string, string>>): string {
  const home = environment.HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

/**
 * Gives the person's files that start code at the agent's next launch,
 * for the `Edit` denies of a launch with this environment.
 *
 * @param environment - The launch's environment.
 * @returns The files and folders, each by its given and its real path.
 */
export async function personsStartUpFiles(
  environment: Readonly<Record<string, string>>,
): Promise<PersonsStartUpFiles> {
  const { config, home } = personsFolders(environment);
  return {
    personsFiles: await givenAndRealPaths([
      join(config.path, 'settings.json'),
      join(config.path, '.claude.json'),
      join(home.path, '.claude.json'),
    ]),
    personsFolders: await givenAndRealPaths([join(config.path, 'plugins')]),
  };
}

/**
 * Tells why the denies of the person's files could miss them in a launch
 * with this environment: a configuration folder or a home that is
 * relative (the agent resolves it against the folder it runs in, which no
 * rule names), or whose path, as given or as the system resolves it, holds
 * a character a permission rule reads as its own.
 *
 * @param environment - The environment a launch would start from.
 * @returns The issues, each with an empty path (the environment is no
 * option of the app's); none when the denies hold.
 */
export async function personsFolderIssues(
  environment: Readonly<Record<string, string>>,
): Promise<Issue[]> {
  const { config, home } = personsFolders(environment);
  const issues = await Promise.all(
    [config, home].map(async ({ variable, path }) => {
      if (!isAbsolute(path)) {
        return [`${variable} gives ${JSON.stringify(path)}, a relative folder`];
      }
      const misread = (await givenAndRealPaths([path])).filter(holdsRuleSyntax);
      return misread.map(
        (found) =>
          `${variable} gives the folder ${JSON.stringify(found)}, which holds a character a permission rule reads as its own (* ? [ ] { } ( ) \\ or a control character)`,
      );
    }),
  );
  return [...new Set(issues.flat())].map((why) => ({
    path: [],
    message: `${why}: the rules that keep the agent from editing its own configuration could miss it.`,
  }));
}
