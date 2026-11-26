import { realpath } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CockpitError } from '../shared/cockpit-error.js';
import type { Confinement, NetworkAddress } from './driver.js';

/**
 * The names that reach every local address, or the loopback, whatever the
 * machine's interfaces: an app's port is denied on them too.
 */
const LOCAL_NAMES: readonly string[] = ['localhost', '0.0.0.0'];

/**
 * The characters a permission rule reads as its own: a pattern's (`*`, `?`,
 * `[`, `]`, `{`, `}`), the rule's brackets around its path (`(`, `)`), its
 * escape (`\`), and any control character. A state root whose path holds
 * one could be missed by its deny rules (`Read(//path/**)`), which have no
 * escape for them all: such a root is refused, failing closed.
 */
const RULE_SYNTAX = /[*?[\]{}()\\]|\p{Cc}/u;

/** Where a launch's confinement is read from. */
export interface ConfinementSources {
  /** The cockpit's state roots, as given: the default one, and the app's folder when it names one. */
  readonly stateRoots: readonly string[];
  /** The ports the app's browser-facing server is known to listen on, now. */
  readonly appPorts: () => readonly number[];
  /** The agent-facing listener's address. */
  readonly listener: NetworkAddress;
}

/**
 * Gives the reader of a launch's {@link Confinement}: read anew at each
 * launch, since the machine's addresses and the app's known ports change.
 * The reader rejects with `CockpitError` `no-app-port` while no port of the
 * app's is known: the session's sandbox could not be kept from the app.
 *
 * @param sources - See {@link ConfinementSources}.
 * @returns A function that reads the confinement.
 */
export function confinementReader(sources: ConfinementSources): () => Promise<Confinement> {
  return async () => {
    const ports = sources.appPorts();
    if (ports.length === 0) {
      throw new CockpitError(
        'no-app-port',
        "No port of the app's browser-facing server is known, so the session's sandbox could not be kept from it: give `port` to createCockpit, or mount the cockpit with an adapter that reads it (cockpitFastify) once the server listens.",
      );
    }
    return {
      stateRoots: await givenAndRealPaths(sources.stateRoots),
      appAddresses: appAddresses(ports),
      listener: sources.listener,
    };
  };
}

/**
 * Each path as given and, when it differs, as the system resolves it: a
 * deny rule matches the path the agent names, which may be either. A path
 * that does not exist yet is resolved as it will be once made: its nearest
 * existing folder's real path, and the rest as given.
 *
 * @param paths - Absolute paths.
 * @returns The paths, each once.
 */
export async function givenAndRealPaths(paths: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map(async (path) => [path, await realPathOf(path)]));
  return [...new Set(resolved.flat())];
}

async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realPathOf(parent), basename(path));
  }
}

/**
 * Tells whether a path holds a character a permission rule reads as its
 * own (`*`, `?`, `[`, `]`, `{`, `}`, `(`, `)`, `\`, a control character):
 * a state root's deny rules could miss it, so the cockpit refuses such a
 * root.
 */
export function holdsRuleSyntax(path: string): boolean {
  return RULE_SYNTAX.test(path);
}

/** Every port on the local names and on every address of every interface, each once. */
function appAddresses(ports: readonly number[]): NetworkAddress[] {
  const hosts = new Set([...LOCAL_NAMES, ...interfaceAddresses()]);
  return ports.flatMap((port) => [...hosts].map((host) => ({ host, port })));
}

function interfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).map(({ address }) => address),
  );
}
