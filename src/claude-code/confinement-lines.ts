import { isIPv6 } from 'node:net';
import type { Confinement, NetworkAddress } from '../server/driver.js';

/**
 * The names that reach the loopback whatever the machine's interfaces.
 * `[::]` is among them: a sandboxed command reached an app on every address
 * through it when it was not listed.
 */
const LOOPBACK_NAMES: readonly string[] = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '::'];

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
 * Gives the sandbox's lines: the app's ports denied on every address of the
 * app's and every loopback name, the listener the one address allowed, and
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
  const ports = new Set(appAddresses.map(({ port }) => port));
  const onLoopback = [...ports].flatMap((port) => LOOPBACK_NAMES.map((host) => ({ host, port })));
  return [...new Set([...appAddresses, ...onLoopback].map(domain))];
}

/** An address as the sandbox's domain lists write it: an IPv6 address in brackets. */
function domain({ host, port }: NetworkAddress): string {
  return isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}
