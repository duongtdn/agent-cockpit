/**
 * Where an adapter reads the ports the app's server listens on: called at
 * each launch, so a server that listens later, or no longer, is read as it
 * is then.
 */
export type AppPortSource = () => readonly number[];

/** The ports of the app's browser-facing server, as the cockpit knows them. */
export interface AppPorts {
  /** The ports the app gave and every source's now, each once. */
  current(): number[];
  /**
   * Adds a source of the app's ports.
   *
   * @returns A function that removes it.
   */
  addSource(source: AppPortSource): () => void;
}

/**
 * The key of the cockpit's member by which an adapter tells it where the
 * app's server listens. A symbol, not a name of the `Cockpit`: it is the
 * adapters' concern, not the app's.
 */
export const APP_PORT_SOURCE: unique symbol = Symbol('agent-cockpit: a source of the app ports');

/** A cockpit an adapter can tell where the app's server listens. */
export interface LearnsAppPorts {
  /**
   * Adds a source of the app's ports.
   *
   * @returns A function that removes it.
   */
  readonly [APP_PORT_SOURCE]: (source: AppPortSource) => () => void;
}

/**
 * Tells whether a cockpit takes a source of the app's ports: one
 * `createCockpit` made does.
 */
export function learnsAppPorts(cockpit: object): cockpit is LearnsAppPorts {
  return typeof (cockpit as Partial<LearnsAppPorts>)[APP_PORT_SOURCE] === 'function';
}

/**
 * Creates the app's ports: those the app gave, joined by every source an
 * adapter adds.
 *
 * @param given - The ports the app gave, `port`.
 */
export function createAppPorts(given: readonly number[]): AppPorts {
  const sources = new Set<AppPortSource>();
  return {
    current: () => [...new Set([...given, ...[...sources].flatMap((source) => source())])],
    addSource(source) {
      // Each adding is its own: one source added twice is removed once per adding.
      const added: AppPortSource = () => source();
      sources.add(added);
      return () => void sources.delete(added);
    },
  };
}
