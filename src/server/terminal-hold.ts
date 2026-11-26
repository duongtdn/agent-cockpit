/**
 * Holds what the page's terminals type into a session while the core types
 * a prompt into it: the pty bridge's side of a send. A person's own
 * `tmux attach` is not held.
 */
export interface TerminalHold {
  /**
   * Holds the keys of every terminal of the session, those attached while
   * it lasts among them, from now until released. Holds of one key nest:
   * the keys pass again once the last is released.
   *
   * @param key - The session's key.
   * @returns The release: the keys held go to the session, in the order
   * they were sent, then the terminals' keys pass again. A second call
   * does nothing.
   */
  hold(key: string): () => void;
}

/** A terminal of the page attached to a session, as the holds see it: the pty bridge's. */
export interface HeldTerminal {
  /** Its keys stop reaching the session; they are kept. */
  hold(): void;
  /** The keys kept go to the session, in the order they were sent, then its keys pass again. */
  release(): void;
}

/** The holds of every session: the core holds a key, the pty bridge's terminals join it. */
export interface TerminalHolds extends TerminalHold {
  /**
   * Adds a terminal attached to a session: held at once when the session's
   * keys are, then at each hold and release of its key.
   *
   * @param key - The session's key.
   * @param terminal - The terminal.
   * @returns Its removal: it is told nothing more.
   */
  join(key: string, terminal: HeldTerminal): () => void;
}

/**
 * Creates the holds of the cockpit's sessions: none held, no terminal
 * joined.
 *
 * @returns The holds.
 */
export function createTerminalHolds(): TerminalHolds {
  const terminalsOf = new Map<string, Set<HeldTerminal>>();
  const holdsOf = new Map<string, number>();

  const terminals = (key: string): readonly HeldTerminal[] => [...(terminalsOf.get(key) ?? [])];

  const unhold = (key: string): void => {
    const left = (holdsOf.get(key) ?? 1) - 1;
    if (left > 0) {
      holdsOf.set(key, left);
      return;
    }
    holdsOf.delete(key);
    for (const terminal of terminals(key)) terminal.release();
  };

  return {
    hold(key) {
      const holds = (holdsOf.get(key) ?? 0) + 1;
      holdsOf.set(key, holds);
      if (holds === 1) for (const terminal of terminals(key)) terminal.hold();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        unhold(key);
      };
    },
    join(key, terminal) {
      const joined = terminalsOf.get(key) ?? new Set();
      terminalsOf.set(key, joined);
      joined.add(terminal);
      if (holdsOf.has(key)) terminal.hold();
      return () => {
        joined.delete(terminal);
        if (joined.size === 0 && terminalsOf.get(key) === joined) terminalsOf.delete(key);
      };
    },
  };
}
