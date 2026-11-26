/**
 * Runs operations one at a time per key, in the order they were asked:
 * each starts once the one before it settled, whatever its outcome, and
 * acts on the state that one left. Operations of different keys run side
 * by side.
 */
export class KeyQueue {
  readonly #last = new Map<string, Promise<unknown>>();

  /**
   * Runs an operation on a key once the operations asked before it settled.
   *
   * @param key - The key.
   * @param operation - The operation.
   * @returns What the operation gives.
   */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const before = this.#last.get(key) ?? Promise.resolve();
    const result = before.then(operation, operation);
    const settled = result.catch(() => undefined);
    this.#last.set(key, settled);
    void settled.then(() => {
      if (this.#last.get(key) === settled) this.#last.delete(key);
    });
    return result;
  }

  /**
   * Tells whether an operation runs, or waits, on a key.
   *
   * @param key - The key.
   */
  isBusy(key: string): boolean {
    return this.#last.has(key);
  }
}
