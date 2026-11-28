/**
 * The agent's asks: what a person must decide before the agent goes on, as
 * the app sees and answers them, and how each one was settled. Both sides
 * read them from here: the server's `cockpit.asks` and the client's
 * `asks` give and take the same values.
 *
 * @packageDocumentation
 */

/**
 * The agent asks whether it may run a tool: its permission dialog. The app
 * draws it from these fields alone and answers it with a
 * {@link PermissionAnswer}.
 */
export interface PermissionAsk {
  /** The ask's id, to answer it by: opaque, unique for the cockpit process's life. */
  readonly id: string;
  /** The key of the unit of work whose session asks. */
  readonly key: string;
  /** Its kind. */
  readonly kind: 'permission';
  /** The agent's name for the tool (`Bash`, `Write`). */
  readonly tool: string;
  /** The tool's input as the agent gave it: a JSON object, its own `description` field included. */
  readonly input: { readonly [field: string]: unknown };
  /** The agent's one-line description of the call, when it gives one. */
  readonly description?: string;
  /**
   * Who can answer it: the app (`'app'`), or only a person in the session's
   * terminal (`'terminal'`), the app's answer then refused `terminal-only`.
   */
  readonly answerable: 'app' | 'terminal';
  /** When the ask opened, an ISO 8601 time. */
  readonly since: string;
}

/** Anything the agent asks a person, one kind per member. */
export type Ask = PermissionAsk;

/**
 * The answer to a {@link PermissionAsk}: allow the call, once or for the
 * rest of the session (`remember: 'session'`), or deny it, with a message
 * the agent gives the model (non-empty, at most 100,000 characters). No
 * other field is taken.
 */
export type PermissionAnswer =
  | { readonly allow: true; readonly remember?: 'session' }
  | { readonly allow: false; readonly message?: string };

/** The answer to an {@link Ask}, of its kind. */
export type AskAnswer = PermissionAnswer;

/**
 * An ask settled, and by whom: the app's answer (`'app'`), a person in the
 * terminal (`'terminal'`), or neither, the ask gone with its turn or its
 * session (`'cancelled'`).
 */
export interface AskSettled {
  /** The ask's id. */
  readonly id: string;
  /** The key of the unit of work whose session asked. */
  readonly key: string;
  /** What settled it. */
  readonly by: 'app' | 'terminal' | 'cancelled';
}
