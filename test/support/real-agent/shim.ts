import { accessSync, chmodSync, constants, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { shellWord } from '../../../src/claude-code/launching.ts';
import type { Driver, LaunchCommand } from '../../../src/server/driver.ts';
import { pinnedAgentBinary } from './binary.ts';
import {
  type AgentFolders,
  agentEnvironment,
  type RecipePiece,
  TERMINAL_VARIABLES,
} from './environment.ts';
import { assertStaysLocal, loopbackOrigin } from './guard.ts';
import { isInside } from './launch-rules.ts';
import { createAgentFolders } from './run-root.ts';

/** What the Claude Code driver launches, looked up on the `PATH` of the server's environment. */
const AGENT_COMMAND = 'claude';

/**
 * The pinned agent in place of the `claude` a driver launches, for a test
 * that runs a cockpit with its real driver: a `claude` of the run's own,
 * first on the server's `PATH`, runs the pinned binary with the recipe's
 * variables and no other, whatever the server's environment holds. The
 * driver's launches are checked by the guard before the cockpit starts
 * them, as the runner's are.
 */
export interface RealAgentShim extends AgentFolders {
  /** Where the cockpit keeps its state: inside the root, so its settings files are checked there. */
  readonly stateFolder: string;
  /**
   * The variables the server's process is given for the test: `PATH`, the
   * shim's folder first, so that the driver launches the shim; `HOME` and
   * `CLAUDE_CONFIG_DIR`, the agent's, so that the driver finds the
   * conversations where the agent keeps them.
   */
  readonly serverVariables: Readonly<Record<string, string>>;
  /**
   * Gives a driver whose every launch is checked before the cockpit starts
   * it: the command resolves to this shim on the launch's `PATH`; the
   * settings file the driver wrote is made read-only, then it and every
   * argument, the work folder and every settings file the agent would read
   * pass the guard's rules, under the variables the shim gives the agent.
   * Nothing else of the driver changes.
   *
   * @param driver - The driver, as an app builds it.
   * @returns The driver, checked.
   */
  guarded(driver: Driver): Driver;
}

/** What a shim is made with, beside the API's address. */
export interface RealAgentShimOptions {
  /**
   * The pieces of the configuration that starts the agent at its input
   * prompt left out, each for the start-up dialog it spares; none by default.
   */
  readonly leftOutOfRecipe?: readonly RecipePiece[];
  /**
   * Variables the shim gives the agent beside the ones that keep it local,
   * over them for a name both have; each must pass its launch rule. None by default.
   */
  readonly variables?: Readonly<Record<string, string>>;
  /**
   * Variables the shim passes on from the launch when the launch carries
   * them, rather than dropping them: what the driver lets through then
   * reaches the agent, checked by the guard as the launch's. None by default.
   */
  readonly passedOn?: readonly string[];
}

/**
 * Makes the run's temporary root, with the agent's folders, a state folder
 * and the shim. Nothing runs until the cockpit launches.
 *
 * @param apiBaseUrl - Where the API's double listens: a plain HTTP address
 * of the loopback interface, with its port.
 * @param options - See {@link RealAgentShimOptions}.
 * @returns The shim; the caller removes its root (`tearDownRun`).
 * @throws Error naming `ANTHROPIC_BASE_URL` when the API's address is not a
 * plain HTTP address of the loopback interface; nothing is made then.
 */
export async function startRealAgentShim(
  apiBaseUrl: string,
  options: RealAgentShimOptions = {},
): Promise<RealAgentShim> {
  const apiOrigin = loopbackOrigin(apiBaseUrl);
  const { leftOutOfRecipe = [], variables = {}, passedOn = [] } = options;
  const folders = await createAgentFolders(leftOutOfRecipe);
  const environment = { ...agentEnvironment(folders, apiOrigin), ...variables };
  const shimFolder = join(folders.root, 'bin');
  const stateFolder = join(folders.root, 'state');
  await mkdir(shimFolder);
  const shim = writeRealAgentShim(shimFolder, environment, pinnedAgentBinary(), passedOn);

  function checkLaunch(command: LaunchCommand, workFolder: string): void {
    const program = onPath(command.command, command.environment.PATH, workFolder);
    if (program !== shim) {
      throw new Error(
        `The real agent is not started: ${JSON.stringify(command.command)} on the launch's PATH is ${JSON.stringify(program)}, not the shim ${shim}.`,
      );
    }
    makeSettingsReadOnly(command.args, folders.root);
    const passed = Object.fromEntries(
      passedOn.flatMap((name) => {
        const value = command.environment[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    assertStaysLocal({
      environment: { ...environment, ...passed },
      args: command.args,
      workFolder,
      root: folders.root,
    });
  }

  return {
    ...folders,
    stateFolder,
    serverVariables: {
      PATH: `${shimFolder}:${process.env.PATH ?? ''}`,
      HOME: folders.home,
      CLAUDE_CONFIG_DIR: folders.configFolder,
    },
    guarded: (driver) => ({
      ...driver,
      async launch(launch) {
        const command = await driver.launch(launch);
        checkLaunch(command, launch.directory);
        return command;
      },
    }),
  };
}

/**
 * Writes a `claude` that runs a program with exactly the variables given,
 * the terminal's own ({@link TERMINAL_VARIABLES}), the ones the session
 * host sets, and those passed on from the launch when it carries them:
 * everything else the launch carries is dropped. The arguments pass as
 * they are.
 *
 * @param folder - An existing folder of the run's own.
 * @param environment - The variables the program is given.
 * @param program - The program's absolute path.
 * @param passedOn - The names of the launch's variables passed on, over the given ones; none by default.
 * @returns The shim's path.
 * @throws Error for a program whose path holds `=`, which `env` would read
 * as a variable, or a name passed on that is no variable's name.
 */
export function writeRealAgentShim(
  folder: string,
  environment: Readonly<Record<string, string>>,
  program: string,
  passedOn: readonly string[] = [],
): string {
  if (program.includes('=')) throw new Error(`The program's path holds "=": ${program}`);
  const unnamed = passedOn.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (unnamed !== undefined) throw new Error(`Not a variable's name: ${JSON.stringify(unnamed)}`);
  const shim = join(folder, AGENT_COMMAND);
  // `${NAME+"NAME=$NAME"}` is one word when the terminal or the launch set NAME, and none when not.
  const whenSet = (name: string) => `\${${name}+"${name}=$${name}"}`;
  const given = Object.entries(environment).map(([name, value]) => shellWord(`${name}=${value}`));
  const words = [
    '/usr/bin/env',
    '-i',
    ...TERMINAL_VARIABLES.map(whenSet),
    ...given,
    ...passedOn.map(whenSet),
    shellWord(program),
    '"$@"',
  ];
  writeFileSync(shim, `#!/bin/sh\nexec ${words.join(' ')}\n`);
  chmodSync(shim, 0o700);
  return shim;
}

/**
 * Finds the program a command names as `execvp` would on a `PATH`, an empty
 * entry being the working folder.
 *
 * @returns Its path, or `undefined` when no entry holds it.
 */
function onPath(command: string, path: string | undefined, workFolder: string): string | undefined {
  if (command.includes('/')) return resolve(workFolder, command);
  return (path ?? '')
    .split(':')
    .map((entry) => join(resolve(workFolder, entry || '.'), command))
    .find(isExecutableFile);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Takes the write permission from the settings file of a launch, when it is
 * one inside the root: the guard lets a settings file pass only once nobody
 * can write it, so that what the agent reads is what was checked.
 */
function makeSettingsReadOnly(args: readonly string[], root: string): void {
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  const at = options.indexOf('--settings');
  const settings = at === -1 ? undefined : options[at + 1];
  if (settings !== undefined && isAbsolute(settings) && isInside(settings, root)) {
    chmodSync(settings, 0o400);
  }
}
