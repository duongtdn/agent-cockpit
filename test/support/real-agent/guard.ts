import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { ROOT_NAME_PREFIX } from './environment.ts';
import {
  aRealFolderInsideTheRoot,
  argumentsProblem,
  isInside,
  isRealFolder,
  plainLoopbackOrigin,
  RULES_FILE,
  ruleIn,
  settingsInFileProblem,
  VARIABLE_RULES,
} from './launch-rules.ts';
import {
  mcpServerFilesOf,
  type SettingsFolders,
  settingsFilesOf,
  worktreeMarkerOf,
} from './settings-sources.ts';

/** Everything a launch hands the agent that decides whom it calls and whose files it reads. */
export interface AgentLaunch {
  /**
   * Every variable the launch gives the agent. Its process has the
   * terminal's own beside them, which no launch carries.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** The agent's arguments, its settings among them, exactly as it would get them. */
  readonly args: readonly string[];
  /** The folder the session would work in. */
  readonly workFolder: string;
  /** The temporary folder the run owns. */
  readonly root: string;
}

/** What the guard knows of the machine it runs on. */
export interface Machine {
  /** The machine's temporary folder, resolved. */
  readonly temporaryFolder: string;
  /** The person's home. */
  readonly home: string;
  /** The folders the agent reads an organization's managed settings from, on this system. */
  readonly managedSettingsFolders: readonly string[];
}

/**
 * Where the agent reads managed settings on Linux, and on WSL, where it
 * may be told to take the ones of Windows. A folder that does not exist
 * holds none.
 */
const MANAGED_SETTINGS_FOLDERS = ['/etc/claude-code', '/mnt/c/Program Files/ClaudeCode'];

/**
 * Refuses a launch in which the agent could reach Anthropic or the person's
 * own configuration. The runner calls it before every launch: no mistake in
 * a test may cost a real request or touch a real login. It asks one
 * question of everything the agent would read — its variables, its
 * arguments, every settings file — is it inside the run's root, and does a
 * rule let it pass? The rules are the tables of `launch-rules.ts`.
 *
 * A machine's managed settings are read under the same rules as any other
 * settings file: an organization's file that only adds permissions lets
 * the suite run, one that could send the agent elsewhere stops it. A file
 * that would give the agent MCP servers — a `.mcp.json` in the work folder
 * or above it, the machine's managed one — stops it whatever it holds: no
 * launch needs servers yet, so none has a rule.
 *
 * @param launch - What the agent would be started with.
 * @param machine - The machine's temporary folder, the person's home and
 * where managed settings are; this machine's by default.
 * @throws Error saying what is refused: a root that is not a folder the
 * runner made in the temporary folder, or that holds the person's home; a
 * work folder that is no real folder inside the root, or that is in a git
 * worktree, whose repository's settings are elsewhere; a variable with no
 * rule, or one missing or holding something else — `ANTHROPIC_BASE_URL`
 * anything but a loopback origin, `HOME`, `CLAUDE_CONFIG_DIR` or `TMPDIR`
 * anything but a real folder inside the root; an argument with no rule, or
 * settings given as a file that can be written; a setting with no rule, or one its rule
 * refuses, on the command line or in any settings file the agent reads; a
 * file of MCP servers the agent would read.
 */
export function assertStaysLocal(launch: AgentLaunch, machine: Machine = thisMachine()): void {
  const problem =
    rootProblem(launch.root, machine) ??
    workFolderProblem(launch) ??
    environmentProblem(launch.environment, launch.root) ??
    argumentsProblem(launch.args, launch.root) ??
    settingsFilesProblem(launch, machine) ??
    mcpServerFilesProblem(launch, machine);
  if (problem !== undefined) throw new Error(`The real agent is not started: ${problem}.`);
}

/**
 * Gives the origin of an API address the agent may be told of: plain HTTP,
 * on the loopback interface by address, with its port, and nothing else — no
 * user, no path. A name is refused, `localhost` too: what it resolves to is
 * the machine's to say. The agent is given the origin and never the address
 * as written, so that it cannot read the text another way than it was read here.
 *
 * @param address - The address, as a test gave it.
 * @returns The origin, such as `http://127.0.0.1:4010`.
 * @throws Error naming `ANTHROPIC_BASE_URL` for any other address.
 */
export function loopbackOrigin(address: string): string {
  const origin = plainLoopbackOrigin(address);
  if (origin === undefined) {
    throw new Error(
      `The real agent is not started: ANTHROPIC_BASE_URL would be ${JSON.stringify(address)}, not a plain http address of the loopback interface, with its port.`,
    );
  }
  return origin;
}

function thisMachine(): Machine {
  return {
    temporaryFolder: realpathSync(tmpdir()),
    // The home of the account, not of a `HOME` a caller may have changed.
    home: userInfo().homedir,
    managedSettingsFolders: MANAGED_SETTINGS_FOLDERS,
  };
}

function rootProblem(root: string, machine: Machine): string | undefined {
  if (!isInside(root, machine.temporaryFolder)) {
    return `the root ${describe(root)} is not a folder inside the temporary folder ${machine.temporaryFolder}`;
  }
  if (root === machine.home || isInside(machine.home, root)) {
    return `the root ${describe(root)} holds the person's home`;
  }
  if (!isMadeByTheRunner(root, machine)) {
    return `the root ${describe(root)} is not a folder the runner made: a real folder of ${machine.temporaryFolder} named ${ROOT_NAME_PREFIX}…`;
  }
  return undefined;
}

function isMadeByTheRunner(root: string, machine: Machine): boolean {
  const isNamedAsOne =
    resolve(root) === root &&
    dirname(root) === machine.temporaryFolder &&
    basename(root).startsWith(ROOT_NAME_PREFIX);
  return isNamedAsOne && isRealFolder(root);
}

function workFolderProblem(launch: AgentLaunch): string | undefined {
  const problem =
    ownWorkFolderProblem(launch.workFolder, launch.root) ??
    workFoldersOf(launch)
      .map(worktreeProblem)
      .find((found) => found !== undefined);
  return problem === undefined
    ? undefined
    : `the work folder ${describe(launch.workFolder)} is ${problem}`;
}

/**
 * A work folder is the run's own: a real folder inside the root, or a link
 * inside it, in a real folder, to one. A link is checked by both paths,
 * since the agent may look for settings above either.
 */
function ownWorkFolderProblem(workFolder: string, root: string): string | undefined {
  if (!isLink(workFolder)) return aRealFolderInsideTheRoot(workFolder, root);
  const leadsToOwn =
    isInside(workFolder, root) &&
    isRealPath(dirname(workFolder)) &&
    existsSync(workFolder) &&
    aRealFolderInsideTheRoot(realpathSync(workFolder), root) === undefined;
  return leadsToOwn ? undefined : `a link that leads to no real folder inside ${root}`;
}

/** The paths the agent may name its work folder by: as given, and resolved. */
function workFoldersOf(launch: AgentLaunch): string[] {
  const resolved = realpathSync(launch.workFolder);
  return resolved === launch.workFolder ? [resolved] : [launch.workFolder, resolved];
}

function isLink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

function isRealPath(path: string): boolean {
  return realpathSync(path) === path;
}

function worktreeProblem(workFolder: string): string | undefined {
  const marker = worktreeMarkerOf(workFolder);
  return marker === undefined
    ? undefined
    : `in a git worktree (${marker} is no folder): the agent would read the settings of a repository elsewhere, which are not checked`;
}

/** Where the agent reads settings, once for each path its work folder goes by. */
function settingsFoldersOf(launch: AgentLaunch, machine: Machine): SettingsFolders[] {
  return workFoldersOf(launch).map((workFolder) => ({
    // Checked before: the environment has it, a real folder inside the root.
    configFolder: launch.environment.CLAUDE_CONFIG_DIR as string,
    workFolder,
    managedSettingsFolders: machine.managedSettingsFolders,
  }));
}

function environmentProblem(
  environment: Readonly<Record<string, string>>,
  root: string,
): string | undefined {
  for (const [name, rule] of Object.entries(VARIABLE_RULES)) {
    if (rule.given === 'required' && environment[name] === undefined) return `${name} is not set`;
  }
  for (const [name, value] of Object.entries(environment)) {
    const rule = ruleIn(VARIABLE_RULES, name);
    if (rule === undefined) {
      return `${name} is no variable an agent is given: it has no rule in VARIABLE_RULES (${RULES_FILE})`;
    }
    if (rule.given === 'by the terminal')
      return `${name} is the terminal's to give, not a launch's`;
    const reason = rule.check(value, root);
    // The key's value stays out of a failure message, fake or not.
    if (reason !== undefined) return `${name} is ${reason}`;
  }
  return undefined;
}

/** Every settings file the agent would read passes the rules the settings of the command line pass. */
function settingsFilesProblem(launch: AgentLaunch, machine: Machine): string | undefined {
  const files = new Set(settingsFoldersOf(launch, machine).flatMap(settingsFilesOf));
  for (const file of files) {
    const problem = settingsInFileProblem(file, launch.root);
    if (problem !== undefined)
      return `the settings of ${file}, which the agent would read: ${problem}`;
  }
  return undefined;
}

function mcpServerFilesProblem(launch: AgentLaunch, machine: Machine): string | undefined {
  const [file] = settingsFoldersOf(launch, machine).flatMap(mcpServerFilesOf);
  return file === undefined
    ? undefined
    : `the MCP servers of ${file}, which the agent would read: no launch needs them yet, so no rule lets any pass`;
}

function describe(value: string): string {
  return JSON.stringify(value);
}
