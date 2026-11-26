/**
 * Calls each of the app's handlers of an event with a value, each on its
 * own: one that throws stops neither the others nor what the cockpit does
 * next (a reconnection among them). What it threw goes to the console, as
 * the browser reports an event listener's throw.
 *
 * @param handlers - The app's handlers, called in order.
 * @param value - What each receives.
 */
export function callEach<T>(handlers: Iterable<(value: T) => void>, value: T): void {
  for (const handler of handlers) {
    try {
      handler(value);
    } catch (failure) {
      console.error('agent-cockpit: a handler of the app threw:', failure);
    }
  }
}
