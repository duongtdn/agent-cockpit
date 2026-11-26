/**
 * Things that arrive one after the other, which a test may await by their
 * number before or after they arrive.
 */
export class Arrivals<T> {
  readonly #arrived: T[] = [];
  readonly #awaited: { readonly number: number; readonly resolve: (item: T) => void }[] = [];

  /** Records the next arrival and hands it to whoever awaits its number. */
  add(item: T): void {
    this.#arrived.push(item);
    for (const waiter of this.#awaited) {
      if (waiter.number === this.#arrived.length) waiter.resolve(item);
    }
  }

  /**
   * Gives the arrival of a number.
   *
   * @param number - Which one, counting from 1.
   * @returns A promise of it, already resolved when it has arrived; it stays
   *   pending for as long as it has not.
   */
  nth(number: number): Promise<T> {
    const arrived = this.#arrived[number - 1];
    if (arrived !== undefined) return Promise.resolve(arrived);
    return new Promise((resolve) => {
      this.#awaited.push({ number, resolve });
    });
  }
}
