import { isIPv6 } from 'node:net';
import type { Confinement, NetworkAddress } from '../server/driver.js';

/** The sandbox's section of a session's settings: what its commands' network may reach. */
export interface SandboxLines {
  readonly network: {
    readonly deniedDomains: readonly string[];
    readonly allowedDomains: readonly string[];
  };
  /** `false`: a command the sandbox would refuse never runs outside it instead. */
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
 * Gives the sandbox's lines: every address of the app's the confinement
 * names denied (the core's list: every loopback name and local address, on
 * every port of the app's), the listener the one address allowed, and
 * no command let out of the sandbox. They do not turn the sandbox on: that
 * stays the person's choice, and without it they change nothing.
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
