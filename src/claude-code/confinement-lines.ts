import { isIPv6 } from 'node:net';
import type { Confinement, NetworkAddress } from '../server/driver.js';

/** The sandbox's section of a session's settings: what its commands' network may reach. */
export interface SandboxLines {
  readonly network: {
    readonly deniedDomains: readonly string[];
    readonly allowedDomains: readonly string[];
  };
  /**
   * `false`: a command the sandbox would refuse never runs outside it
   * instead. The app's own `sandbox.allowUnsandboxedCommands` replaces it.
   */
  readonly allowUnsandboxedCommands: false;
}

/**
 * Gives the permission rules that keep the agent's tools out of the state
 * roots. An `Edit` deny joins the `Read` deny: without it the shell's plain
 * writes (`echo >`, `cp`, `rm`) still land there when the sandbox is off.
 *
 * @param stateRoots - The roots, absolute, each by every path that names it.
 * @returns The deny rules, written as Claude Code reads an absolute path (`//abs/**`).
 */
export function stateRootDenies(stateRoots: readonly string[]): string[] {
  return stateRoots.flatMap((root) => {
    const pattern = `/${root.replace(/\/+$/, '')}/**`;
    return [`Read(${pattern})`, `Edit(${pattern})`];
  });
}

/**
 * Claude Code's files that start code at its next launch wherever a
 * project or a folder holds them: the project's settings and its local
 * ones, a parent repository's, the session's `~/.claude` (their hooks),
 * and a project's MCP servers (`.mcp.json`).
 */
const START_UP_FILES_ANYWHERE: readonly string[] = [
  '//**/.claude/settings.json',
  '//**/.claude/settings.local.json',
  '//**/.mcp.json',
];

/**
 * Gives the permission rules that keep the agent's own tools from every
 * file that starts code at its next launch: settings (their hooks), the
 * configuration files and a project's `.mcp.json` (their MCP servers), the
 * person's plugins. Its `Write` and `Edit` tools run outside the sandbox,
 * and what such a file starts runs, unsandboxed, at the next start; in
 * `bypassPermissions` nothing asks first. The rules stop the tools and the
 * shell commands Claude Code recognizes; code the agent runs outside the
 * sandbox still writes (as for the state roots).
 *
 * @param personsFiles - The person's own such files, absolute, each by
 * every path that names it: their settings (`<config>/settings.json`) and
 * configuration files (`<config>/.claude.json`, `~/.claude.json`).
 * @param personsFolders - The person's own folders every file of which
 * is denied, absolute, each by every path that names it: their plugins
 * (`<config>/plugins`).
 * @returns The `Edit` deny rules.
 */
export function startUpFileDenies(
  personsFiles: readonly string[],
  personsFolders: readonly string[],
): string[] {
  return [
    ...START_UP_FILES_ANYWHERE,
    ...personsFiles.map((file) => `/${file}`),
    ...personsFolders.map((folder) => `/${folder.replace(/\/+$/, '')}/**`),
  ].map((pattern) => `Edit(${pattern})`);
}

/**
 * Gives the sandbox's lines: every address of the app's the confinement
 * names denied (the core's list: every loopback name and local address, on
 * every port of the app's), the listener the one address allowed, and
 * no command let out of the sandbox. They do not turn the sandbox on
 * themselves: the person's own settings do, or the app's `sandbox` option,
 * whose `allowUnsandboxedCommands` then replaces their `false`. Without
 * the sandbox they change nothing.
 *
 * @param confinement - The launch's confinement.
 * @returns The sandbox's section of the settings.
 */
export function sandboxLines(confinement: Confinement): SandboxLines {
  return {
    network: {
      deniedDomains: deniedDomains(confinement.appAddresses),
      allowedDomains: [domain(confinement.listener)],
    },
    allowUnsandboxedCommands: false,
  };
}

function deniedDomains(appAddresses: readonly NetworkAddress[]): string[] {
  return [...new Set(appAddresses.map(domain))];
}

/** An address as the sandbox's domain lists write it: an IPv6 address in brackets. */
function domain({ host, port }: NetworkAddress): string {
  return isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}
