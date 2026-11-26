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

import type { Issue } from '../shared/cockpit-error.js';
import type { BackgroundTask, EndReason, StartupDialog, TurnError } from '../shared/session.js';
import type { KeyRule } from '../shared/wire.js';
import type { AgentVersion, TestedRange } from './agent-status.js';

/**
 * The path, under a session's {@link HookAddress.url}, that the listener
 * takes the agent's hooks on, and the driver posts every hook to: the
 * payload names its event. One constant, so that the two never disagree.
 */
export const HOOKS_PATH = '/hooks';

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

/** An address on the machine: a host, by name or by IP address, and a port. */
export interface NetworkAddress {
  /** A name (`localhost`) or an IP address (`127.0.0.1`, `::1`), IPv6 without brackets. */
  readonly host: string;
  /** The port. */
  readonly port: number;
}

/**
 * What the cockpit keeps out of the agent's reach, for one launch: the
 * driver writes the lines its agent needs for it into the session's
 * settings, whatever the app sets.
 */
export interface Confinement {
  /**
   * The cockpit's state roots — the default one and the folder the app gives,
   * each by the path given and, when it differs, its real path — which the
   * agent may neither read nor write.
   */
  readonly stateRoots: readonly string[];
  /**
   * Every address the app's browser-facing surfaces may be reached at: each
   * of the app's ports on every loopback name (`localhost`, `127.0.0.1`,
   * `0.0.0.0`, `::1`, `::`) and on every address of every interface. The
   * ports and the interfaces are read at each launch; a running session
   * keeps the lines it was launched with. A sandboxed agent's network may
   * reach none of them; a driver writes them as they are, adding none.
   */
  readonly appAddresses: readonly NetworkAddress[];
  /** The agent-facing listener, which the session's hooks must reach. */
  readonly listener: NetworkAddress;
}

/**
 * How far the commands of a driver's sessions reach the network without
 * asking the person, as the app set the driver.
 */
export type SessionNetwork =
  /**
   * No further than the confinement's lines allow; beyond them, the agent
   * asks or refuses, never reaches.
   */
  | { readonly reach: 'confined' }
  /**
   * Beyond the allow-list, without asking: other local ports, the internet,
   * the person's files. The cockpit then refuses to be opened beyond
   * loopback unless the app accepted it in the driver's options.
   */
  | {
      readonly reach: 'open';
      /** Whether the app accepted it, in the driver's options. */
      readonly accepted: boolean;
      /** Why, and how the app accepts it, in the driver's terms: the refusal's message. */
      readonly reason: string;
    };

/**
 * A job's driver part (ADR-0051): what a job sets of the agent's own
 * options — for Claude Code its permission mode, rules and model — built by
 * the driver's factory (`claudeCode.job(…)`) and carried by the job as
 * `driver`. Opaque to the core, which only hands it back to the driver: to
 * check it, to tell its network, and with each launch of the job.
 */
export type DriverPart = object;

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
  /**
   * Whether the conversation `conversationId` exists and is resumed, rather
   * than started under that id; a new one when left out.
   */
  readonly resume?: boolean;
  /** The driver part of the job the launch runs, when it has one: laid over the app's options. */
  readonly part?: DriverPart;
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
  /** What the agent must not reach, which the driver writes into the session's settings. */
  readonly confinement: Confinement;
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
      /** The turn ended on an error of the model's API, after the agent's own retries: `idle`. */
      readonly type: 'turn-failed';
      /** Why it failed. */
      readonly error: TurnError;
    }
  | {
      /**
       * The agent began to compact its conversation: `busy` if the session
       * was `idle`, no change otherwise.
       */
      readonly type: 'compaction-began';
    }
  | {
      /** The compaction ended: the session returns to the state it began in. */
      readonly type: 'compaction-ended';
    }
  | {
      /** The tasks running in the background, the whole list, at the end of a turn. */
      readonly type: 'tasks';
      /** Every task still running; none when the list is empty. */
      readonly running: readonly BackgroundTask[];
    }
  | {
      /** One background task finished: it leaves the list. */
      readonly type: 'task-finished';
      /** The task's id. */
      readonly id: string;
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
 * What the agent's screen shows while the core waits for its first hook: a
 * start-up dialog (named when the driver knows it), the ready input box, or
 * nothing it can tell yet.
 */
export type ScreenReading =
  | {
      /** A dialog the person must answer in the terminal before the agent goes on. */
      readonly shows: 'dialog';
      /** Which, when the driver knows it; absent for a dialog it does not recognize. */
      readonly dialog?: StartupDialog;
    }
  | {
      /** The agent's input box, ready for a prompt. */
      readonly shows: 'ready';
    }
  | {
      /** Nothing the driver can tell: the agent still drawing, or a screen it does not know. */
      readonly shows: 'nothing';
    };

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
  /** The oldest and the newest versions of the agent its contract tests ran on. */
  readonly testedRange: TestedRange;
  /**
   * Reads the version of the agent a launch with this environment would run.
   *
   * @param environment - The environment the launch starts from: its `PATH` finds the agent.
   * @returns The version and how it stands against {@link testedRange}, or
   * that no agent was found.
   */
  agentVersion(environment: Readonly<Record<string, string>>): Promise<AgentVersion>;
  /**
   * Checks a job's driver part against the driver's type, as its factory
   * does: an app in JavaScript may write one by hand.
   *
   * @param part - The job's `driver`, unchecked.
   * @returns Every issue found, each path from the part; none when it fits.
   */
  checkPart(part: unknown): readonly Issue[];
  /**
   * Tells how far the commands of a session reach the network without
   * asking: the app's options, with a job's part laid over them.
   *
   * @param part - The job's driver part, checked; none for the app's own options.
   * @returns The session's network.
   */
  networkOf(part?: DriverPart): SessionNetwork;
  /**
   * Reads the agent's screen, as the terminal shows it in text, while the
   * core waits for the agent's first hook.
   *
   * @param text - The screen, line by line.
   * @returns What it shows.
   */
  readScreen(text: string): ScreenReading;
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
