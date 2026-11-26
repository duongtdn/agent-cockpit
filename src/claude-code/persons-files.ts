import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { givenAndRealPaths, holdsRuleSyntax } from '../server/confinement.js';
import type { Issue } from '../shared/cockpit-error.js';
import { agentConfigFolder } from './conversations.js';

/** The person's own files and folders that start code at the agent's next launch. */
export interface PersonsStartUpFiles {
  /**
   * Their settings (`<config>/settings.json`: hooks), the legacy
   * configuration file (`<config>/.config.json`, which the agent reads over
   * `.claude.json` when it holds anything: MCP servers), and each
   * configuration file found in the configuration folder or the home under
   * any of its names (`.claude*.json`), each by the path the agent reads it
   * at and by its real path.
   */
  readonly personsFiles: readonly string[];
  /**
   * The folders the agent reads its configuration file in, under any of
   * its names (`.claude*.json`: `.claude.json`, or a suffixed one), whether
   * it exists yet or not: the configuration folder and the home, by both
   * paths.
   */
  readonly configurationFileFolders: readonly string[];
  /**
   * Their folders every file of which is denied: plugins, agents and skills
   * (`<config>/plugins`, `agents`, `skills`: an agent's or a skill's
   * frontmatter may hold hooks), by both paths.
   */
  readonly personsFolders: readonly string[];
}

/** A folder of the person's the denies name, and how a refusal names it. */
interface PersonsFolder {
  readonly path: string;
  /** How a refusal names the folder's source: the variable that gives it, or how the agent derives it. */
  readonly givenBy: string;
  /** Whether a problem of this folder is a problem of the home already told. */
  readonly underHome: boolean;
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
      path: agentConfigFolder(environment),
      givenBy: named
        ? 'CLAUDE_CONFIG_DIR gives'
        : 'The default configuration folder, .claude in HOME, is',
      underHome: !named,
    },
    home: { path: homeOf(environment), givenBy: 'HOME gives', underHome: false },
  };
}

function homeOf(environment: Readonly<Record<string, string>>): string {
  const home = environment.HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

/** How the agent names its configuration file: `.claude.json`, or with a suffix. */
const CONFIGURATION_FILE_NAME = /^\.claude.*\.json$/;

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
  const configurationFiles = [
    ...(await configurationFilesIn(config.path)),
    ...(await configurationFilesIn(home.path)),
  ];
  return {
    personsFiles: await givenAndRealPaths([
      join(config.path, 'settings.json'),
      join(config.path, '.config.json'),
      ...configurationFiles,
    ]),
    configurationFileFolders: await givenAndRealPaths([config.path, home.path]),
    personsFolders: await givenAndRealPaths(
      ['plugins', 'agents', 'skills'].map((name) => join(config.path, name)),
    ),
  };
}

/**
 * The configuration files a folder holds, under any of their names: the
 * pattern of the denies names each by the path the agent reads it at, and
 * this list leads to the real path of one that is a link.
 */
async function configurationFilesIn(folder: string): Promise<string[]> {
  try {
    const names = await readdir(folder);
    return names
      .filter((name) => CONFIGURATION_FILE_NAME.test(name))
      .map((name) => join(folder, name));
  } catch {
    // A folder the agent cannot read gives it no configuration file either.
    return [];
  }
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
  const homeIssues = await folderIssues(home);
  const configIssues = config.underHome && homeIssues.length > 0 ? [] : await folderIssues(config);
  return [...homeIssues, ...configIssues].map((why) => ({
    path: [],
    message: `${why}: the rules that keep the agent from editing its own configuration could miss it.`,
  }));
}

/**
 * Tells why the denies could miss one of the person's folders: at most
 * one reason, the first of a relative path, the path as given holding
 * rule syntax, or its real path holding it.
 */
async function folderIssues({ path, givenBy }: PersonsFolder): Promise<string[]> {
  if (!isAbsolute(path)) return [`${givenBy} ${JSON.stringify(path)}, a relative folder`];
  const found = (await givenAndRealPaths([path])).find(holdsRuleSyntax);
  if (found === undefined) return [];
  const where =
    found === path
      ? `the folder ${JSON.stringify(path)}, which`
      : `the folder ${JSON.stringify(path)}, whose real path ${JSON.stringify(found)}`;
  return [
    `${givenBy} ${where} holds a character a permission rule reads as its own (* ? [ ] { } ( ) \\ or a control character)`,
  ];
}
