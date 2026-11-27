/**
 * Runs operations one at a time per key, in the order they were asked:
 * each starts once the one before it settled, whatever its outcome, and
 * acts on the state that one left. Operations of different keys run side
 * by side.
 */
export class KeyQueue {
  readonly #last = new Map<string, Promise<unknown>>();
  /** Settled once the queue is closed: an operation waiting for its turn stops waiting. */
  readonly #closing: Promise<void>;
  #close: () => void = () => {};
  /** What an operation that has not begun is rejected with, once the queue is closed. */
  #refusal: ((key: string) => unknown) | undefined;

  constructor() {
    this.#closing = new Promise((resolve) => {
      this.#close = resolve;
    });
  }

  /**
   * Runs an operation on a key once the operations asked before it settled.
   *
   * @param key - The key.
   * @param operation - The operation.
   * @returns What the operation gives; once the queue is closed, before
   * its turn came, the queue's refusal.
   */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const before = this.#last.get(key) ?? Promise.resolve();
    const turn = Promise.race([before.then(settledAnyhow, settledAnyhow), this.#closing]);
    const result = turn.then(() => {
      if (this.#refusal !== undefined) throw this.#refusal(key);
      return operation();
    });
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

  /**
   * Closes the queue: every operation that has not begun, waiting for its
   * turn or asked from now on, is rejected at once with the refusal and
   * never runs. One that has begun runs on.
   *
   * @param refusal - Gives what an operation of the key is rejected with.
   */
  close(refusal: (key: string) => unknown): void {
    this.#refusal ??= refusal;
    this.#close();
  }
}

function settledAnyhow(): void {}
