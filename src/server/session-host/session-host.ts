/** The size of a terminal, in character cells. */
export interface TerminalSize {
  /** How many cells wide. */
  readonly columns: number;
  /** How many cells high. */
  readonly rows: number;
}

/** What a session's process finds in its environment, beyond the calling process's own. */
export interface SessionEnvironment {
  /** Variables to set, by name. */
  readonly set: Readonly<Record<string, string>>;
  /** Names of variables the process must not see, whoever set them. */
  readonly remove: readonly string[];
}

/** What a session is started with. */
export interface StartOptions {
  /** The session's name, unique on the host: letters, digits, `-` and `_`. */
  readonly name: string;
  /** The directory the command runs in: an absolute path; it must exist. */
  readonly folder: string;
  /**
   * The program to run: a name looked up on the session's `PATH`, or a path.
   * It must not contain `=`.
   */
  readonly command: string;
  /** The program's arguments. Each reaches it as given: no shell reads them. */
  readonly args: readonly string[];
  /**
   * Changes to the environment the command would otherwise get, which is
   * the calling process's at the start (`process.env`), with the folder as
   * `PWD` and no `OLDPWD`. The host sets a few variables itself, whatever is
   * set here: those of the terminal it gives the session.
   */
  readonly environment: SessionEnvironment;
  /** The terminal's size until a terminal attaches. */
  readonly size: TerminalSize;
}

/** How literal text is typed: in writes small and slow enough to read as typing. */
export interface TextPacing {
  /** The most characters (code points) in one write. */
  readonly chunkLength: number;
  /** The pause between two writes, in milliseconds. */
  readonly pauseMs: number;
}

/** Where a terminal's cursor is, counted from 0. */
export interface CursorPosition {
  /** Its row, from the top of the visible screen. */
  readonly row: number;
  /** Its column, from the left. */
  readonly column: number;
}

/** What a session's terminal shows. */
export interface Screen {
  /**
   * The visible rows, top to bottom, joined by line breaks; trailing blanks
   * of a row are dropped.
   */
  readonly text: string;
  /**
   * Where the terminal's cursor is, shown or hidden: a program that draws
   * its own cursor, as Claude Code does in its input box, puts the
   * terminal's there too.
   */
  readonly cursor: CursorPosition;
  /**
   * Whether a person scrolled the terminal back: it then shows its history
   * and takes keys as commands of that view, not as input of the program.
   */
  readonly inCopyMode: boolean;
}

/** The process a session runs. */
export interface SessionProcess {
  /** Its process id: the command's own, with no shell in between. */
  readonly pid: number;
}

/**
 * A terminal attached to a session: what the session draws comes out, what is
 * written goes to it as a person's keys. Several can be attached to one
 * session; detaching one leaves the session running.
 */
export interface Attachment {
  /**
   * Listens to what the session draws. The first listener also gets what was
   * drawn since the terminal attached — the whole screen, as the host drew it
   * for the new terminal — so that none of it is lost before anyone listens.
   *
   * @param listener - Called with each piece of terminal output, as text.
   * @returns A function that stops the listening.
   */
  onData(listener: (data: string) => void): () => void;
  /**
   * Listens to the end of the attachment: it was detached, or its session
   * ended. A listener added after the end is called too.
   *
   * @returns A function that stops the listening.
   */
  onEnd(listener: () => void): () => void;
  /** Sends keys or other terminal input to the session. */
  write(data: string): void;
  /**
   * Tells the session the terminal's new size.
   *
   * @throws `RangeError` for a size that is no whole number of cells, one or more.
   */
  resize(size: TerminalSize): void;
  /**
   * Detaches the terminal; the session goes on.
   *
   * @returns A promise fulfilled once the host no longer counts the terminal.
   */
  detach(): Promise<void>;
}

/**
 * Where sessions live: each a program in a terminal of its own that outlives
 * the process that started it. The cockpit's core and its driver start, type
 * into, read, attach to and end sessions through this interface and never
 * through what implements it.
 *
 * Every operation fails by rejecting, never by throwing. Unless stated
 * otherwise, an operation on a session that does not live rejects with a
 * `SessionHostError` of reason `no-session`, and one the host could not
 * carry out, or did not answer in time, with reason `host-failed`.
 */
export interface SessionHost {
  /**
   * Checks that the machine has what the host needs.
   *
   * @throws `CockpitError` `unsupported-machine` when it does not;
   * `SessionHostError` `host-failed` when the host could not be asked, or
   * did not answer in time.
   */
  checkMachine(): Promise<void>;
  /**
   * Starts a session, detached, and applies the host's settings.
   *
   * The promise is fulfilled once the host has created the session and
   * handed it the command: it does not wait to see the command run. A
   * command that cannot be executed — not found, not executable — ends its
   * session at once, as a command that exits does, and `isLive` tells.
   *
   * @throws `TypeError` for a name, a folder, a command or a variable's
   * name that cannot be used, and for a NUL character in any of them, in an
   * argument or in a value; `RangeError` for a size that is no whole number
   * of cells, one or more.
   * @throws `SessionHostError` `session-exists` when the name lives;
   * `no-folder` when the folder is no directory; `host-failed` when the
   * command, an argument or a variable (with its name) is of 128 KiB or
   * more, which no system executes a command with, and when the host
   * failed or did not answer in time. Never `no-session`.
   */
  start(options: StartOptions): Promise<void>;
  /**
   * Lists the names of the sessions that live.
   *
   * @throws `SessionHostError` `host-failed` when the host failed, or did
   * not answer in time.
   */
  list(): Promise<string[]>;
  /**
   * Tells whether a session lives. A session whose command exited does not.
   *
   * @throws `TypeError` for a name that cannot be a session's.
   * @throws `SessionHostError` `host-failed` when the host failed, or did
   * not answer in time. Never `no-session`.
   */
  isLive(name: string): Promise<boolean>;
  /**
   * Gives a session's process, or `undefined` when the session does not live.
   *
   * @throws `TypeError` for a name that cannot be a session's.
   * @throws `SessionHostError` `host-failed` when the host failed, or did
   * not answer in time. Never `no-session`.
   */
  processOf(name: string): Promise<SessionProcess | undefined>;
  /**
   * Types text into a session, character for character, after leaving
   * copy-mode. Line breaks are typed as they are: what key a line break is
   * for the program is the caller's to decide.
   *
   * @throws `TypeError` for a name that cannot be a session's; `RangeError`
   * for a `chunkLength` that is no whole number, one or more.
   * @throws `SessionHostError` `no-session` when the session does not live;
   * `host-failed` when the host failed, or did not answer in time.
   * Text typed before the failure stays typed; an empty text asks the host
   * nothing, and so fails for nothing but its `chunkLength`.
   */
  sendText(name: string, text: string, pacing: TextPacing): Promise<void>;
  /**
   * Presses named keys in a session, in order, after leaving copy-mode.
   *
   * @param keys - Key names: `Enter`, `Escape`, `Tab`, `BTab`, `BSpace`,
   * `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`,
   * `PageDown`, `IC`, `DC`, `F1` to `F12`, each with optional `C-` and `M-`
   * prefixes; or one printable ASCII character but `;` with such a prefix
   * (`C-u`).
   * @throws `TypeError` for a name that cannot be a session's, for no key,
   * and for a key the host does not know: no key is then pressed.
   * @throws `SessionHostError` `no-session` when the session does not live;
   * `host-failed` when the host failed, or did not answer in time.
   */
  sendKeys(name: string, keys: readonly string[]): Promise<void>;
  /**
   * Sends bytes to a session's program as they are, after leaving copy-mode.
   *
   * @throws `TypeError` for a name that cannot be a session's.
   * @throws `SessionHostError` `no-session` when the session does not live;
   * `host-failed` when the host failed, or did not answer in time.
   * Bytes sent before the failure stay sent; no bytes ask the host nothing,
   * and so fail for nothing.
   */
  sendBytes(name: string, bytes: Uint8Array): Promise<void>;
  /**
   * Reads what a session's terminal shows.
   *
   * @throws `TypeError` for a name that cannot be a session's.
   * @throws `SessionHostError` `no-session` when the session does not live;
   * `host-failed` when the host failed, or did not answer in time.
   */
  readScreen(name: string): Promise<Screen>;
  /**
   * Attaches a terminal of the given size to a session.
   *
   * @returns The attachment, once the session takes its input: what is
   * written to it right away reaches the session's program.
   * @throws `TypeError` for a name that cannot be a session's; `RangeError`
   * for a size that is no whole number of cells, one or more.
   * @throws `SessionHostError` `no-session` when the session does not live;
   * `host-failed` when the host failed, or the terminal was not attached in
   * time.
   */
  attach(name: string, size: TerminalSize): Promise<Attachment>;
  /**
   * Counts the terminals attached to a session, the host's and any other.
   *
   * @throws `TypeError` for a name that cannot be a session's.
   * @throws `SessionHostError` `no-session` when the session does not live;
   * `host-failed` when the host failed, or did not answer in time.
   */
  countAttached(name: string): Promise<number>;
  /**
   * Ends a session at once, with its process.
   *
   * @returns `'killed'`, or `'gone'` when the session did not live.
   * @throws `TypeError` for a name that cannot be a session's.
   * @throws `SessionHostError` `host-failed` when the host failed, or did
   * not answer in time. Never `no-session`.
   */
  kill(name: string): Promise<'killed' | 'gone'>;
  /**
   * Ends every session of the host and what the host itself runs, and waits
   * until it is gone. For shutdown and for tests: sessions are meant to
   * outlive the cockpit's process. Where the host runs nothing, it does
   * nothing, and starts nothing.
   *
   * @throws `SessionHostError` `host-failed` when the host failed, did not
   * answer in time, or did not end. Never `no-session`.
   */
  shutDown(): Promise<void>;
}
