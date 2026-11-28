import { CockpitError, type CockpitErrorFields } from '../shared/cockpit-error.js';

/** Where an internal failure happened. */
export type FailureSite = CockpitErrorFields['internal-failure']['where'];

/** What an internal failure gives the app: an `internal-failure` error. */
export type InternalFailure = CockpitError<'internal-failure'>;

/** The cockpit's report of internal failures to the app's `error` handlers. */
export interface FailureReport {
  /**
   * Reports a failure: every handler receives it as `internal-failure`; with
   * none, the fallback does. A handler that throws does not stop the others:
   * what it threw goes to the fallback.
   *
   * @param where - Where it happened.
   * @param cause - What was thrown.
   */
  report(where: FailureSite, cause: unknown): void;
  /**
   * Adds a handler.
   *
   * @returns A function that removes it.
   */
  on(handler: (error: InternalFailure) => void): () => void;
}

const MESSAGES: Readonly<Record<FailureSite, string>> = {
  handler: "The cockpit's handler failed while serving a browser's request: it answered 500.",
  authorize: "The app's authorize threw or rejected: the request was refused.",
  'agent-listener': 'The agent-facing listener failed while serving a hook: it answered 500.',
  'session-host': 'The session host failed to end a session: it is still live.',
};

/**
 * Makes the error an internal failure gives the app: what a report hands
 * each handler, and what an operation rejects with when the machine failed
 * under it.
 *
 * @param where - Where it happened.
 * @param cause - What was thrown.
 * @returns The `internal-failure` error.
 */
export function internalFailure(where: FailureSite, cause: unknown): InternalFailure {
  return new CockpitError('internal-failure', MESSAGES[where], { where, cause });
}

/**
 * Creates the report of internal failures: they reach the app, never the
 * wire, where they would show the server's inside.
 *
 * @param fallback - Receives each failure while the app has no handler
 * (the console, by default), and what a handler throws.
 */
export function createFailureReport(
  fallback: (error: unknown) => void = (error) => console.error(error),
): FailureReport {
  const handlers = new Set<(error: InternalFailure) => void>();
  return {
    report(where, cause) {
      const error = internalFailure(where, cause);
      if (handlers.size === 0) return fallback(error);
      for (const handler of handlers) {
        try {
          handler(error);
        } catch (thrown) {
          fallback(thrown);
        }
      }
    },
    on(handler) {
      // A handler given twice is two subscriptions, each removed by its own function.
      const subscription = (error: InternalFailure): void => handler(error);
      handlers.add(subscription);
      return () => {
        handlers.delete(subscription);
      };
    },
  };
}
