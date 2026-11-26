/** What a liveness watch asks the host, and whom it tells. */
export interface LivenessWatchOptions {
  /** Lists the names of the sessions that live on the host. */
  readonly list: () => Promise<readonly string[]>;
  /** Called once for each watched session found gone; it is no longer watched. */
  readonly onGone: (key: string) => void;
  /** How long between two lists, in milliseconds. */
  readonly intervalMs: number;
}

/**
 * Watches sessions on the host by one periodic list for all of them, and
 * only while there is one to watch: a session host tells of no end, and one
 * list costs the same whatever the number of sessions.
 */
export class LivenessWatch {
  readonly #options: LivenessWatchOptions;
  /**
   * The sessions watched, each with the mark of its watch: a session
   * unwatched and watched again while a list was out is a new watch, which
   * that list cannot speak for.
   */
  readonly #watched = new Map<string, symbol>();
  #timer: NodeJS.Timeout | undefined;
  #listing = false;

  /** @param options - See {@link LivenessWatchOptions}. */
  constructor(options: LivenessWatchOptions) {
    this.#options = options;
  }

  /**
   * Watches a session, which must live on the host by now: a list that was
   * asked for before it was watched does not count for it.
   */
  watch(key: string): void {
    this.#watched.set(key, Symbol(key));
    this.#timer ??= setInterval(() => void this.#tick(), this.#options.intervalMs).unref();
  }

  /** Stops watching a session. */
  unwatch(key: string): void {
    this.#watched.delete(key);
    if (this.#watched.size === 0) this.#stop();
  }

  /** Stops watching every session. */
  close(): void {
    this.#watched.clear();
    this.#stop();
  }

  #stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #tick(): Promise<void> {
    // A host slower than the interval gets one list at a time, not a queue.
    if (this.#listing) return;
    this.#listing = true;
    const asked = new Map(this.#watched);
    try {
      const live = new Set(await this.#options.list());
      for (const [key, mark] of asked) {
        if (!live.has(key) && this.#watched.get(key) === mark) {
          this.unwatch(key);
          this.#options.onGone(key);
        }
      }
    } catch {
      // A list that failed tells nothing of any session: the next one will.
    } finally {
      this.#listing = false;
    }
  }
}
