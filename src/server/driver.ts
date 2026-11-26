/**
 * The boundary between the core and the driver of one coding agent. The core
 * owns the sessions, their states, the listener the agent calls and the
 * terminal; the driver owns what only its agent knows: how to launch it, what
 * its hooks mean, where it keeps conversations, and which keys its terminal
 * needs. The core calls a driver only through this interface and imports
 * none; a driver's entry builds one from the app's options.
 *
 * It holds what the core needs from the one driver that exists, and no more:
 * it is internal, and a second agent is expected to reshape it.
 *
 * @packageDocumentation
 */

import type { EndReason } from '../shared/session.js';
import type { KeyRule } from '../shared/wire.js';

/** Where the agent reports to: the cockpit's agent-facing listener, for one session. */
export interface HookAddress {
  /**
   * The base URL the session's hooks are sent to, on `127.0.0.1`; the driver
   * may add a path of its own under it.
   */
  readonly url: string;
  /**
   * The session's token for this launch, sent as `Authorization: Bearer` on
   * every request to the listener. The driver writes it only in the session's
   * files, never on a command line or in the environment, where any process
   * of the user can read it.
   */
  readonly token: string;
}

/** What the core asks a driver to launch: one start of the agent for one session. */
export interface Launch {
  /** The session's key, which names it on the host and in the state folder. */
  readonly key: string;
  /**
   * The id of the conversation to start, a UUID the core minted and records:
   * the agent keeps the conversation under it, so a later launch can resume
   * it.
   */
  readonly conversationId: string;
  /** The folder the agent works in: the app's, or the job's inside it. An absolute path. */
  readonly directory: string;
  /**
   * The session's own folder in the state folder, which exists and only the
   * app's user can read: where the driver writes the files of this launch
   * (each readable by that user alone), those carrying the token among them.
   */
  readonly files: string;
  /** Where the agent reports to, and with which token. */
  readonly hooks: HookAddress;
  /** The first prompt, taken by the agent at start; absent for a launch to type in. */
  readonly prompt?: string;
  /**
   * The environment the agent would get: the server's, without the
   * variables the app hides. The driver removes what its agent must not
   * inherit, and adds its own.
   */
  readonly environment: Readonly<Record<string, string>>;
}

/** How to run the agent for a launch; the core gives it to the session host as it is. */
export interface LaunchCommand {
  /** The program: a name looked up on the `PATH`, or a path. */
  readonly command: string;
  /** Its arguments, each passed as it is, with no shell between. */
  readonly args: readonly string[];
  /**
   * The agent's whole environment, beside the terminal's own variables the
   * host sets. Exactly this: nothing inherited reaches the agent otherwise.
   */
  readonly environment: Readonly<Record<string, string>>;
}

/** A request the listener took from a session's agent, its token checked. */
export interface HookRequest {
  /** The key of the session whose token the request carried. */
  readonly key: string;
  /** The request's path, under the session's {@link HookAddress.url}. */
  readonly path: string;
  /** The request's body, parsed as JSON. */
  readonly body: unknown;
}

/**
 * Why the agent says it is ending, when it says so. Only a hint: the session
 * has ended only when its process is gone, and a reason the cockpit has of
 * its own (it ended the session itself) prevails.
 */
export type AgentEndReason = Extract<EndReason, 'agent-exit' | 'lost'>;

/**
 * What a hook tells the core, in the cockpit's terms rather than the agent's.
 * The driver reports facts; the core decides the session's state from them
 * and from what it launched.
 */
export type DriverEvent =
  | {
      /**
       * The agent takes input, and its hooks arrive: the proof that the
       * session can be observed. Without a prompt at launch, the session is
       * `idle` from here.
       */
      readonly type: 'ready';
    }
  | {
      /** The agent took a prompt and started a turn: `busy`. */
      readonly type: 'prompt-taken';
    }
  | {
      /** The agent works on its turn, a tool started or finished: `busy`. */
      readonly type: 'working';
    }
  | {
      /** The turn ended: `idle`. */
      readonly type: 'turn-ended';
      /** The turn's last message, when the agent gave one. */
      readonly lastMessage?: string;
    }
  | {
      /** The agent is ending, and says why. */
      readonly type: 'ending';
      /** Why. */
      readonly reason: AgentEndReason;
    };

/** What a driver makes of a hook request. */
export interface HookOutcome {
  /**
   * What the request tells the core, in order: none for a hook that changes
   * nothing, such as one of a background task's.
   */
  readonly events: readonly DriverEvent[];
}

/** A conversation the agent may keep, as a launch named it. */
export interface Conversation {
  /** The conversation's id, as the launch gave it. */
  readonly conversationId: string;
  /** The folder the session worked in: the agent may keep conversations by folder. */
  readonly directory: string;
}

/**
 * The driver of one coding agent, as the core sees it. The app builds one
 * with the driver's own entry (`claudeCode(…)`) and gives it to
 * `createCockpit`; it holds the app's options for that agent.
 */
export interface Driver {
  /**
   * The driver's terminal keys, sent first on every terminal connection of
   * its sessions.
   */
  readonly terminalKeys: readonly KeyRule[];
  /**
   * Why a launch whose agent never reported `ready` cannot be observed, in
   * the agent's own terms: the cause of the `unobservable` error the launch
   * fails with.
   */
  readonly silentStartCause: string;
  /**
   * Prepares a launch: writes the files it needs in the session's folder and
   * says how to run the agent.
   *
   * @param launch - What to launch.
   * @returns The command, its arguments and the agent's environment.
   */
  launch(launch: Launch): Promise<LaunchCommand>;
  /**
   * Reads a request of the agent's hooks.
   *
   * @param request - The request, already proved to come from the session's
   * agent.
   * @returns What it tells the core.
   */
  readHook(request: HookRequest): HookOutcome;
  /**
   * Tells whether the agent still keeps a conversation, so that an ended
   * session can say whether it may resume.
   *
   * @param conversation - The conversation, as it was launched.
   * @returns `true` when the agent could resume it.
   */
  canResume(conversation: Conversation): Promise<boolean>;
}
