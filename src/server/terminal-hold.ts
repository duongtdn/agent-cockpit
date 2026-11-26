/**
 * Holds what the page's terminals type into a session while the core types
 * a prompt into it: the pty bridge's side of a send. A person's own
 * `tmux attach` is not held.
 */
export interface TerminalHold {
  /**
   * Holds the keys of every terminal of the session, those attached while
   * it lasts among them, from now until released.
   *
   * @param key - The session's key.
   * @returns The release: the keys held go to the session, in the order
   * they were sent, then the terminals' keys pass again. A second call
   * does nothing.
   */
  hold(key: string): () => void;
}
