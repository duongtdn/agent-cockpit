import type { Pending, SessionState } from './session.js';

/** One way a value does not fit what was expected of it. */
export interface Issue {
  /** Where in the value: the property names and array indexes that lead to it. */
  readonly path: readonly (string | number)[];
  /** What is wrong there, in English, for developers. */
  readonly message: string;
}

/**
 * The fields each {@link CockpitError} code carries, by code. The keys of this
 * interface are every code the cockpit throws or rejects with.
 */
export interface CockpitErrorFields {
  /** The options given to a factory do not fit. */
  'invalid-options': {
    /** Each way the options do not fit. */
    issues: readonly Issue[];
  };
  /** The machine lacks something the cockpit needs. */
  'unsupported-machine': {
    /** Which requirement is not met. */
    what: 'platform' | 'tmux' | 'node';
    /** What the machine has. */
    found: string;
    /** What the cockpit needs. */
    required: string;
  };
  /** Another process of the app already runs a cockpit with sessions. */
  'cockpit-locked': {
    /**
     * The id of the process that holds the lock, as the system tells it; or
     * `another-user` when the holder is none of the user's processes, whose
     * id the cockpit cannot learn.
     */
    holder: number | 'another-user';
  };
  /** The app has no job of that id (any more). */
  'unknown-job': {
    /** The id asked for, or the id of the job the unit of work last ran. */
    jobId: string;
  };
  /** The arguments do not fit the job's schema. */
  'invalid-arguments': {
    /** Each way the arguments do not fit. */
    issues: readonly Issue[];
  };
  /** A value is not among the choices its field offers. */
  'not-a-choice': {
    /** The name of the argument. */
    field: string;
    /** The value given for it. */
    value: unknown;
  };
  /** The job's folder lies outside the app's. */
  'folder-outside-app': {
    /** The folder the job gives. */
    folder: string;
  };
  /** The job's folder differs from the one its unit of work started in. */
  'folder-changed': {
    /** The folder the unit of work started in. */
    recorded: string;
    /** The folder the job gives now. */
    computed: string;
  };
  /** No unit of work has that key: a unit of work begins with a run. */
  'unknown-key': {
    /** The key asked for. */
    key: string;
  };
  /** The session's state refuses the operation. */
  'wrong-state': {
    /** The key of the unit of work. */
    key: string;
    /** The state the session is in. */
    state: SessionState;
    /** On a `waiting` session, everything it waits for. */
    pending?: readonly Pending[];
  };
  /** The agent did not take the prompt. */
  'prompt-not-taken': {
    /** The key of the unit of work. */
    key: string;
    /** The state the session was left in. */
    state: SessionState;
  };
  /** The prompt is longer than the cockpit types. */
  'prompt-too-long': {
    /** The prompt's length, in characters. */
    length: number;
    /** The longest prompt accepted, in characters. */
    max: number;
  };
  /** The turn was interrupted, but the session was not seen `idle` in time. */
  'interrupt-unconfirmed': {
    /** The key of the unit of work. */
    key: string;
    /** The last state known. */
    state: SessionState;
  };
  /** The agent's command cannot be run. */
  'agent-not-found': {
    /** The command the driver tried to run. */
    command: string;
  };
  /** The agent is older than the oldest version the driver was tested on. */
  'agent-too-old': {
    /** The agent's version on this machine. */
    found: string;
    /** The oldest version the driver was tested on. */
    oldestTested: string;
  };
  /** The agent's signals do not arrive; the session was ended. */
  unobservable: {
    /** The key of the unit of work. */
    key: string;
    /** What the driver could tell of the reason, in its own words. */
    cause: string;
  };
  /** The cap on live sessions is reached and no idle one can be ended. */
  'session-cap-reached': {
    /** The most sessions that may be live at once. */
    cap: number;
    /** The keys of the live sessions. */
    live: readonly string[];
  };
  /**
   * A launch was refused: no port of the app's browser-facing server is
   * known, so the agent's sandbox could not be kept from it. The app gives
   * `port` with the neutral handler; the Fastify adapter reads it once the
   * server listens.
   */
  'no-app-port': Record<never, never>;
  /**
   * A launch was refused: the app asked for its sessions to run in the
   * agent's sandbox, and the sandbox cannot run on this machine. The
   * session is never started unsandboxed instead.
   */
  'sandbox-unavailable': {
    /** What the driver could tell of the reason, in its own words: what is missing, and how to get it. */
    cause: string;
  };
  /** No ask or channel request has that id. */
  'unknown-id': {
    /** The id asked for. */
    id: string;
  };
  /** The ask or channel request was settled before this answer. */
  'already-settled': {
    /** The id of the ask or the channel request. */
    id: string;
    /** Who or what settled it. */
    by: 'app' | 'terminal' | 'cancelled' | 'lost';
  };
  /** The ask can only be answered in the terminal. */
  'terminal-only': {
    /** The id of the ask. */
    id: string;
  };
  /** The answer does not fit what the ask or the channel request expects. */
  'invalid-answer': {
    /** The id of the ask or the channel request. */
    id: string;
    /** Each way the answer does not fit. */
    issues: readonly Issue[];
  };
  /** The agent is not logged in. */
  'not-logged-in': Record<never, never>;
  /** The model asked for cannot be used. */
  'model-unavailable': {
    /** The model asked for. */
    model: string;
  };
  /** The result does not fit the output schema. */
  'invalid-output': {
    /** Each way the result does not fit. */
    issues: readonly Issue[];
    /** The result as the model gave it. */
    raw: string;
  };
  /** The model's API answered with an error. */
  'api-error': {
    /** The HTTP status, when there was one. */
    status?: number;
    /** What the API said of the error. */
    detail: string;
  };
  /** The request checks refused the request. */
  refused: {
    /** The check that refused it. */
    cause: 'remote' | 'forwarded' | 'origin' | 'host' | 'local-address' | 'terminal-off';
  };
  /** The request carries no valid token: the person must open the app's link. */
  'no-token': Record<never, never>;
  /** The server cannot be reached. */
  unreachable: Record<never, never>;
  /**
   * A failure inside the cockpit, or in a function of the app's it calls:
   * never sent on the wire, given to the app's `error` handlers. `cause` is
   * what was thrown.
   */
  'internal-failure': {
    /**
     * Where: the browser-facing handler, the app's `authorize`, the
     * agent-facing listener, or an app's handler of the asks
     * (`asks.follow`'s, `asks.on('settled')`'s).
     */
    where: 'handler' | 'authorize' | 'agent-listener' | 'asks';
  };
}

/** A code of a {@link CockpitError}: kebab-case, one per kind of failure. */
export type CockpitErrorCode = keyof CockpitErrorFields;

/**
 * The properties that make the error's identity. They are the error's own:
 * no code has a field of these names, and details never set them.
 */
const IDENTITY = ['name', 'code', 'message', 'stack', 'toJSON'] as const;

/**
 * What a `CockpitError` of one code is built from: the fields of the code
 * and, where the code names no cause of its own, the error that lies under
 * it; nothing of the error's identity. Given several codes, one such type
 * for each.
 */
type DetailsOfEach<C extends CockpitErrorCode> = C extends CockpitErrorCode
  ? CockpitErrorFields[C] &
      ('cause' extends keyof CockpitErrorFields[C] ? unknown : { cause?: unknown }) & {
        [K in (typeof IDENTITY)[number]]?: never;
      }
  : never;

/** What fits every member of a union at once. */
type FitsAll<Union> = (Union extends unknown ? (member: Union) => void : never) extends (
  all: infer All,
) => void
  ? All
  : never;

/**
 * What a `CockpitError` is built from. A code known only as one of several
 * needs the fields of them all, since any of them may be the code.
 */
type Details<C extends CockpitErrorCode> = FitsAll<DetailsOfEach<C>>;

type DetailsArgument<C extends CockpitErrorCode> =
  Record<never, never> extends Details<C> ? [details?: Details<C>] : [details: Details<C>];

/** The codes that define a `cause` of their own. */
type CodeWithCauseField = {
  [C in CockpitErrorCode]: 'cause' extends keyof CockpitErrorFields[C] ? C : never;
}[CockpitErrorCode];

/** On these codes `cause` is a field like the others, not the error that lies under. */
const CAUSE_IS_A_FIELD: Record<CodeWithCauseField, true> = {
  unobservable: true,
  refused: true,
  'sandbox-unavailable': true,
};

class CodedError<C extends CockpitErrorCode> extends Error {
  /** Always `'CockpitError'`, whatever the code. */
  override readonly name = 'CockpitError';
  /** The kind of failure; it decides the other fields. */
  readonly code: C;

  constructor(code: C, message: string, ...[details]: DetailsArgument<C>) {
    const { cause, ...fields }: { cause?: unknown } = details ?? {};
    const causeIsAField = Object.hasOwn(CAUSE_IS_A_FIELD, code);
    super(message, causeIsAField || cause === undefined ? undefined : { cause });
    this.code = code;
    // Every field is an enumerable property of the error itself, so that a
    // spread, a log and `toJSON` all see the same fields.
    Object.assign(this, withoutIdentity(fields), causeIsAField ? { cause } : undefined);
  }

  /**
   * What `JSON.stringify` keeps of the error: its `name`, its `code`, its
   * `message` and the fields of its code. The stack and the error that lies
   * under it stay out: they are the server's own.
   *
   * @returns A plain object with those properties.
   */
  toJSON(): Record<string, unknown> {
    return { ...(this as object), message: this.message };
  }
}

/**
 * Details reach the constructor from untyped code too (a parsed body, a
 * spread of another error); what they hold under a name of the identity is
 * dropped, so that an error is always what its constructor was told.
 */
function withoutIdentity(fields: object): object {
  const identity: readonly string[] = IDENTITY;
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !identity.includes(name)));
}

/**
 * Every error the cockpit throws or rejects with, on the server and in the
 * browser alike. Its `code` tells the failures apart and decides its other
 * fields ({@link CockpitErrorFields}), so `switch (error.code)` narrows them.
 * Its `message` is an English sentence for logs and developers, not for the
 * person using the app. `cause` is the error that lies under it, when there
 * is one, except on the codes that define a `cause` of their own.
 * `JSON.stringify` keeps its `name`, `code`, `message` and the fields of its
 * code, and nothing else.
 */
export type CockpitError<C extends CockpitErrorCode = CockpitErrorCode> = {
  [K in C]: CodedError<K> & Readonly<CockpitErrorFields[K]>;
}[C];

/**
 * Creates a {@link CockpitError}.
 *
 * @param code - The kind of failure.
 * @param message - An English sentence for logs and developers.
 * @param details - The fields of the code, and optionally `cause`; may be
 * left out when the code has no required field. A code known only as one of
 * several needs the fields of them all. What details hold under `name`,
 * `code`, `message`, `stack` or `toJSON` is dropped: those are the error's
 * own.
 */
export const CockpitError = CodedError as new <C extends CockpitErrorCode>(
  code: C,
  message: string,
  ...details: DetailsArgument<C>
) => CockpitError<C>;

/**
 * Tells whether a value is a {@link CockpitError}, narrowing its type.
 *
 * @param value - Anything, typically what a `catch` received.
 * @param code - When given, the value must also have this code.
 * @returns `true` for a `CockpitError` (of that code, when one is given).
 */
export function isCockpitError<C extends CockpitErrorCode = CockpitErrorCode>(
  value: unknown,
  code?: C,
): value is CockpitError<C> {
  return value instanceof CodedError && (code === undefined || value.code === code);
}
