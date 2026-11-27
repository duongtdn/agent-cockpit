import { settlesBeforeAbort } from './abort-race.js';

/**
 * Lets the next operation of the key begin while the one that calls it
 * runs on: an operation left waiting for a person frees its turn.
 */
export type FreeTurn = () => void;

/**
 * Runs operations one at a time per key, in the order they were asked:
 * each starts once the one before it settled, or freed its turn, whatever
 * its outcome, and acts on the state that one left. Operations of
 * different keys run side by side.
 */
export class KeyQueue {
  /** Each key's last turn asked: over once its operation settled, or freed it. */
  readonly #last = new Map<string, Promise<void>>();
  readonly #closing: AbortSignal;
  readonly #refusal: (key: string) => unknown;

  /**
   * @param closing - Closes the queue once aborted: every operation that
   * has not begun, waiting for its turn or asked from then on, is rejected
   * at once with the refusal and never runs. One that has begun runs on.
   * @param refusal - Gives what an operation of the key is rejected with
   * once the queue is closed.
   */
  constructor(closing: AbortSignal, refusal: (key: string) => unknown) {
    this.#closing = closing;
    this.#refusal = refusal;
  }

  /**
   * Runs an operation on a key once the operations asked before it
   * settled, or freed their turn.
   *
   * @param key - The key.
   * @param operation - The operation, given the function that frees its turn.
   * @returns What the operation gives; once the queue is closed, before
   * its turn came, the queue's refusal.
   */
  run<T>(key: string, operation: (freeTurn: FreeTurn) => Promise<T>): Promise<T> {
    const before = this.#last.get(key) ?? Promise.resolve();
    let endTurn = () => {};
    const turn = new Promise<void>((resolve) => {
      endTurn = resolve;
    });
    const freeTurn: FreeTurn = () => {
      endTurn();
      if (this.#last.get(key) === turn) this.#last.delete(key);
    };
    this.#last.set(key, turn);
    const result = settlesBeforeAbort(before, this.#closing).then((came) => {
      if (!came || this.#closing.aborted) throw this.#refusal(key);
      return operation(freeTurn);
    });
    result.then(freeTurn, freeTurn);
    return result;
  }

  /**
   * Tells whether an operation runs, or waits, on a key, its turn not freed.
   *
   * @param key - The key.
   */
  isBusy(key: string): boolean {
    return this.#last.has(key);
  }
}
