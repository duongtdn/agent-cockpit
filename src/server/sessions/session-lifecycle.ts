/**
 * Where a session's launch and life stand, beyond its public state: one
 * table of the phases, the moves allowed between them and what each phase
 * lets the core do, and the one going from the host every end awaits.
 *
 * @packageDocumentation
 */

/** A phase of a session's lifecycle. */
export type Phase =
  /** Its key is taken; the host is asked whether an earlier session holds it. */
  | 'reserved'
  /**
   * It is listed `starting`; the agent is not on the host yet. Its hooks
   * are heard from the moment its token is granted.
   */
  | 'launching'
  /** It lives on the host. */
  | 'live'
  /**
   * It lives on the host, and the cockpit asked its agent to end: its hooks
   * are heard as it goes, but nothing is typed into it.
   */
  | 'ending'
  /** It lives on the host, and the cockpit is killing it: its hooks are not heard. */
  | 'killing'
  /** It is gone from the host; its end is being written. */
  | 'going'
  /** It ended. */
  | 'ended';

/** What a phase allows: the moves out of it, and what the core does with a session in it. */
interface PhaseRules {
  /** The phases a session in this one may move to. */
  readonly to: readonly Phase[];
  /** Whether a lifecycle may begin in it. */
  readonly startsHere: boolean;
  /** Whether the agent was started on the host and is not known gone. */
  readonly onHost: boolean;
  /** Whether what the agent tells is listened to. */
  readonly listened: boolean;
  /** Whether a prompt may be typed into the session. */
  readonly takesInput: boolean;
}

/**
 * The lifecycle's one table. A launch that fails leaves `reserved` or
 * `launching` by no move: its entry is removed. A kill that fails leaves
 * the session `live`: its agent is heard again, and a later end may kill it.
 */
const PHASES = {
  reserved: {
    to: ['launching'],
    startsHere: true,
    onHost: false,
    listened: false,
    takesInput: false,
  },
  launching: { to: ['live'], startsHere: false, onHost: false, listened: true, takesInput: true },
  live: {
    to: ['ending', 'killing', 'going'],
    startsHere: false,
    onHost: true,
    listened: true,
    takesInput: true,
  },
  ending: {
    to: ['killing', 'going'],
    startsHere: false,
    onHost: true,
    listened: true,
    takesInput: false,
  },
  killing: {
    to: ['live', 'going'],
    startsHere: false,
    onHost: true,
    listened: false,
    takesInput: false,
  },
  going: { to: ['ended'], startsHere: false, onHost: false, listened: false, takesInput: false },
  ended: { to: [], startsHere: false, onHost: false, listened: false, takesInput: false },
} as const satisfies Readonly<Record<Phase, PhaseRules>>;

/** The phases a lifecycle may begin in, as the table names them. */
export type StartPhase = {
  [P in Phase]: (typeof PHASES)[P]['startsHere'] extends true ? P : never;
}[Phase];

/**
 * A move the table does not allow: a programming error of the core, never
 * a race, since a caller in a race asks {@link SessionLifecycle.can} first.
 */
export class LifecycleMoveError extends Error {
  override readonly name = 'LifecycleMoveError';

  /**
   * @param from - The phase the session was in.
   * @param to - The phase it was moved to.
   */
  constructor(from: Phase, to: Phase) {
    super(`A session's lifecycle cannot move from ${from} to ${to}.`);
  }
}

/**
 * Tells what becomes of a session once its going is written: called with
 * the lifecycle `ended`, before any caller of the going resumes.
 */
export type TellEnd = () => void;

/** The lifecycle of one session: its phase, moved only as the table allows. */
export class SessionLifecycle {
  #phase: Phase;
  /** Settles once the session ended and its end was told. */
  readonly #ended = settledByHand();
  /** Settles once the end the cockpit began did; none while no end is under way. */
  #endUnderWay: SettledByHand | undefined;

  /**
   * @param start - The phase it begins in: `reserved`, for a launch.
   * @throws `LifecycleMoveError` for a phase no lifecycle begins in.
   */
  constructor(start: StartPhase) {
    if (!PHASES[start].startsHere) throw new LifecycleMoveError(start, start);
    this.#phase = start;
  }

  /** The phase the session is in. */
  get phase(): Phase {
    return this.#phase;
  }

  /**
   * Whether the table allows the move from the phase the session is in.
   *
   * @param to - The phase to move to.
   */
  can(to: Phase): boolean {
    const allowed: readonly Phase[] = PHASES[this.#phase].to;
    return allowed.includes(to);
  }

  /**
   * Moves the session to another phase.
   *
   * @param to - The phase.
   * @throws `LifecycleMoveError` for a move the table does not allow.
   */
  move(to: Phase): void {
    if (!this.can(to)) throw new LifecycleMoveError(this.#phase, to);
    const from = this.#phase;
    this.#phase = to;
    if (from === 'live' && this.isBeingEnded) this.#endUnderWay = settledByHand();
    if (to === 'ended' || to === 'live') {
      this.#endUnderWay?.settle();
      this.#endUnderWay = undefined;
    }
  }

  /**
   * Settles once the end under way did: the session ended, or a kill that
   * failed left it live. A session going from the host is awaited ended;
   * one in any other phase has no end under way, and it settles at once.
   */
  get endUnderWay(): Promise<void> {
    if (this.hasLeftTheHost) return this.#ended.promise;
    return this.#endUnderWay?.promise ?? Promise.resolve();
  }

  /**
   * Goes from the host, once, however many find the session gone: the
   * first caller's going runs, and every caller awaits the same end. A
   * session never put on the host has nothing to go from.
   *
   * @param going - Writes the end: it gives the function that tells it,
   * which is called once the session is `ended`.
   * @returns A promise fulfilled once the session ended and its end was told.
   */
  go(going: () => Promise<TellEnd>): Promise<void> {
    if (this.can('going')) void this.#go(going);
    return this.hasLeftTheHost ? this.#ended.promise : Promise.resolve();
  }

  /** Fulfilled once the session ended and its end was told; never, for one that does not end. */
  get ended(): Promise<void> {
    return this.#ended.promise;
  }

  /** Whether the agent was started on the host and is not known gone. */
  get isOnHost(): boolean {
    return PHASES[this.#phase].onHost;
  }

  /** Whether what the agent tells is listened to: from its launch until the cockpit kills it, or it is gone. */
  get isListened(): boolean {
    return PHASES[this.#phase].listened;
  }

  /** Whether a prompt may be typed into it: from its launch until the cockpit asks it to end. */
  get takesInput(): boolean {
    return PHASES[this.#phase].takesInput;
  }

  /** Whether it lives on the host, and the cockpit is not ending it: an end may begin. */
  get isLive(): boolean {
    return this.#phase === 'live';
  }

  /** Whether the cockpit is ending it: its agent asked to end, or being killed. */
  get isBeingEnded(): boolean {
    return this.#phase === 'ending' || this.#phase === 'killing';
  }

  /** Whether an end is under way: the cockpit ending it, or its going from the host, not yet written. */
  get hasEndUnderWay(): boolean {
    return this.isBeingEnded || this.#phase === 'going';
  }

  /** Whether its key is only taken: the launch is not listed yet. */
  get isReserved(): boolean {
    return this.#phase === 'reserved';
  }

  /** Whether it ended: its key is free for another launch. */
  get isEnded(): boolean {
    return this.#phase === 'ended';
  }

  /** Whether it is gone from the host, its end written or being written. */
  get hasLeftTheHost(): boolean {
    return this.#phase === 'going' || this.#phase === 'ended';
  }

  async #go(going: () => Promise<TellEnd>): Promise<void> {
    this.move('going');
    try {
      const tell = await going();
      this.move('ended');
      tell();
    } finally {
      // A going that failed still ends the session: no caller waits forever.
      if (this.can('ended')) this.move('ended');
      this.#ended.settle();
    }
  }
}

/** A promise settled by hand. */
interface SettledByHand {
  readonly promise: Promise<void>;
  settle(): void;
}

function settledByHand(): SettledByHand {
  let settle = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}
