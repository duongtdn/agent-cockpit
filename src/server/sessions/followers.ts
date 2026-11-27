import type { Session } from '../../shared/session.js';

/** Told the whole list of the sessions, now and at each change. */
export type Follower = (sessions: readonly Session[]) => void;

/**
 * The followers of a list of sessions. One that throws stops neither the
 * others nor the change it was told of, which has happened already: what
 * it threw goes to the fallback, as a handler's throw does elsewhere in
 * the cockpit.
 */
export class Followers {
  readonly #followers = new Set<Follower>();
  readonly #fallback: (thrown: unknown) => void;

  /** @param fallback - Receives what a follower throws: the console, by default. */
  constructor(fallback: (thrown: unknown) => void = (thrown) => console.error(thrown)) {
    this.#fallback = fallback;
  }

  /**
   * Adds a follower, and tells it the list now.
   *
   * @param listener - The follower: given twice, it is two followers.
   * @param now - The list as it is.
   * @returns A function that removes it.
   */
  add(listener: Follower, now: readonly Session[]): () => void {
    const follower: Follower = (sessions) => listener(sessions);
    this.#followers.add(follower);
    this.#tellOne(follower, now);
    return () => void this.#followers.delete(follower);
  }

  /**
   * Tells every follower the list.
   *
   * @param list - Gives the list; not asked when there is no follower.
   */
  tell(list: () => readonly Session[]): void {
    if (this.#followers.size === 0) return;
    const sessions = list();
    for (const follower of this.#followers) this.#tellOne(follower, sessions);
  }

  /** Removes every follower. */
  clear(): void {
    this.#followers.clear();
  }

  #tellOne(follower: Follower, sessions: readonly Session[]): void {
    try {
      follower(sessions);
    } catch (thrown) {
      this.#fallback(thrown);
    }
  }
}
