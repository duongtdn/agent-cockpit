import { realpath } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import type { Confinement, NetworkAddress } from './driver.js';

/**
 * The names that reach every local address, or the loopback, whatever the
 * machine's interfaces: an app's port is denied on them too.
 */
const LOCAL_NAMES: readonly string[] = ['localhost', '0.0.0.0'];

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
 *
 * @param sources - See {@link ConfinementSources}.
 * @returns A function that reads the confinement.
 */
export function confinementReader(sources: ConfinementSources): () => Promise<Confinement> {
  return async () => ({
    stateRoots: await givenAndRealPaths(sources.stateRoots),
    appAddresses: appAddresses(sources.appPorts()),
    listener: sources.listener,
  });
}

/**
 * Each path as given and, when it differs, as the system resolves it: a
 * deny rule matches the path the agent names, which may be either. A path
 * that does not exist yet is kept as given.
 */
async function givenAndRealPaths(paths: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(
    paths.map(async (path) => [path, await realpath(path).catch(() => path)]),
  );
  return [...new Set(resolved.flat())];
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
