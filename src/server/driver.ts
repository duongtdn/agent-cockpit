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
import type { Screen } from './session-host/session-host.js';

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
 * How far a driver's sessions act beyond the cockpit's lines without
 * asking the person, as the app set the driver: whether their commands
 * reach the network beyond the allow-list, and whether their file tools
 * write files no one was asked about, which a hook may then run outside
 * any sandbox.
 */
export type SessionNetwork =
  /**
   * No further than the confinement's lines allow; beyond them, the agent
   * asks or refuses, never reaches; and its file tools ask before a write,
   * refuse it, or write nothing.
   */
  | { readonly reach: 'confined' }
  /**
   * Beyond the lines, without asking: its commands reach the network
   * beyond the allow-list (other local ports, the internet, the person's
   * files), or its file tools write files unasked, or both. The cockpit
   * then refuses to be opened beyond loopback unless the app accepted it in
   * the driver's options.
   */
  | {
      readonly reach: 'open';
      /** Whether the app accepted it, in the driver's options. */
      readonly accepted: boolean;
      /**
       * Why — its network, its unasked writes, or both — and how the app
       * accepts it, in the driver's terms: the refusal's message.
       */
      readonly reason: string;
    };

/**
 * A job's driver part: what a job sets of the agent's own
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
      /**
       * The conversation the agent keeps the session's work in, as it
       * starts one: the one launched, or a new one under another id (Claude
       * Code's `/clear`). From then on the core follows that one, and an
       * ended session resumes it.
       */
      readonly type: 'conversation';
      /** The conversation's id. */
      readonly conversationId: string;
    }
  | {
      /** The agent took a prompt and started a turn: `busy`. */
      readonly type: 'prompt-taken';
      /**
       * The prompt as the agent took it, when it says: what confirms that a
       * prompt the driver typed was the one taken.
       */
      readonly prompt?: string;
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
      /**
       * A person interrupted the turn in the terminal, which no hook
       * reports: `idle`, with no last message.
       */
      readonly type: 'interrupted';
      /**
       * When the agent recorded it, an ISO 8601 time, when it says. Told
       * later than the hooks, an interruption recorded before the last
       * prompt was taken ended an earlier turn, and leaves the new one as
       * it is.
       */
      readonly at?: string;
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
      /**
       * The compaction ended, done, failed or interrupted: the session
       * returns to the state it began in.
       */
      readonly type: 'compaction-ended';
    }
  | {
      /**
       * The agent recorded the end of a command of its own, run with no turn
       * and no hook (Claude Code's local commands: `/clear`, `/context`,
       * `/compact`, an unknown one): it took the input and waits for the
       * next. A launch prompt that was such a command is done (`idle`),
       * whichever entry tells it; a compaction begun while `idle` is over
       * only at a caveat recorded once it began.
       */
      readonly type: 'command-done';
      /**
       * The entry that told it: `caveat`, the note a command's record opens
       * with and all that an interrupted command writes (Claude Code's
       * `<local-command-caveat>`); `result`, the command's output, its
       * error, or the entry of a command the agent does not know.
       */
      readonly entry: 'caveat' | 'result';
      /**
       * When the agent recorded it, an ISO 8601 time, when it says. Written
       * up to a few hundred milliseconds late, an earlier command's caveat
       * recorded before a compaction began does not end it.
       */
      readonly at?: string;
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

/** A conversation the agent may keep: the one a launch named, or one the agent moved to. */
export interface Conversation {
  /** The conversation's id. */
  readonly conversationId: string;
  /** The folder the session worked in: the agent may keep conversations by folder. */
  readonly directory: string;
  /**
   * The environment the session was launched with, as the driver's launch
   * was given it: where the agent keeps its conversations may follow from
   * it, and differ from the server's own.
   */
  readonly environment: Readonly<Record<string, string>>;
}

/** A conversation the core follows, and whether it is known to be new. */
export interface FollowedConversation extends Conversation {
  /**
   * Whether the conversation is known to be new: a launch that resumes
   * none, or one the agent moved to (Claude Code's `/clear`). What it holds
   * is then all of this session's, and is read from its start, however
   * early the agent wrote it; an earlier conversation, resumed, is read
   * from where it stands, its past not told again.
   */
  readonly isNew: boolean;
}

/**
 * What the agent's screen shows of where to type and of what waits for a
 * person in the terminal: a start-up dialog (named when the driver knows
 * it), a panel the agent drew over its input box, the input box free to
 * type into, a screen the driver does not know, or nothing yet.
 *
 * Never whether the agent is idle or busy: the core reads it to know when a
 * dialog waits, and when a prompt can be typed (the start's deadline, the
 * first prompt typed after the start). The few places the screen is a sign
 * of the agent's state are {@link ScreenStateSigns}, apart.
 */
export type ScreenReading =
  | {
      /** A dialog the person must answer in the terminal before the agent goes on. */
      readonly shows: 'dialog';
      /** Which, when the driver knows it; absent for a dialog it does not recognize. */
      readonly dialog?: StartupDialog;
    }
  | {
      /**
       * A panel drawn in place of the input box, which waits for a key in the
       * terminal: what a local command opens (Claude Code's `/help`, `/model`).
       */
      readonly shows: 'panel';
      /** The driver's name for it, for its own tests: the core passes it on nowhere. */
      readonly panel: string;
    }
  | {
      /**
       * The agent's input box with nothing drawn over it, a prompt typed now
       * taken as one: never while the agent shows it works, whatever a person
       * typed in the box.
       */
      readonly shows: 'input-box';
    }
  | {
      /**
       * A screen the driver does not know: no input box, and no dialog or
       * panel it can name; a panel it has no words for, or a screen half
       * drawn.
       */
      readonly shows: 'unknown';
    }
  | {
      /** Nothing it can tell: a blank screen, or the input box while the agent works. */
      readonly shows: 'nothing';
    };

/**
 * The places the agent's screen is a sign of its state, where no hook,
 * transcript entry or other signal of the agent's tells it: the whole list.
 * Each one was shown to have no other signal, reads only what the agent
 * draws for that fact, and is held by a contract row on the pinned agent at
 * every change of the pin. A new place is a decision of its own, recorded
 * with its evidence, before it joins this list.
 */
export interface ScreenStateSigns {
  /**
   * Tells that a panel a launch prompt opened, one the driver named, has
   * closed: the input box back, with no sign above it that the agent works.
   * The agent then waits for a prompt (`idle`): a panel's close fires no
   * hook and writes no entry. A screen or a dialog of no name is never
   * read so: the core waits for the next hook or entry.
   *
   * @param text - The screen, row by row, read once a panel was seen.
   * @returns `true` once the panel is gone and the agent waits.
   */
  launchPanelClosed(text: string): boolean;
  /**
   * Tells that an Esc pressed before the model answered withdrew the
   * turn's prompt: the agent put it back into its empty input box, and
   * waits for a prompt (`idle`), with no hook, no transcript entry, no
   * other sign. The input box holds exactly the prompt, compared with
   * every run of whitespace left out (the box breaks a wrapped line where
   * a space was), and the screen shows no sign above the box that the
   * agent works. A prompt taller than the box shows scrolled to its end,
   * rows hidden above: the rows shown must then be the prompt's end. Over a draft the same Esc interrupts instead, and the box
   * holds the draft alone: never read so. Nor is a box under a dialog, an
   * entry recalled from the history, or a screen the driver cannot read.
   *
   * @param text - The screen, row by row, as the terminal shows it: never
   * a person's scrolling back, which the core does not read.
   * @param prompt - The turn's prompt, as the agent took it.
   * @returns `true` when the box holds the prompt withdrawn.
   */
  promptWithdrawn(text: string, prompt: string): boolean;
}

/** A value JSON writes and reads back the same: what the cockpit keeps in its files. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [name: string]: JsonValue };

/**
 * What of the driver's reaches a launch with a job's part, as data: the
 * app's options with the part laid over them. The core records it for each
 * session and compares it as a whole: a run whose settings differ restarts
 * an `idle` session with its own.
 */
export type DriverSettings = JsonValue;

/** How the core ends a live session gracefully, the agent keeping its conversation. */
export interface SessionEnding {
  /** The signal the agent's process is sent: it exits, its conversation resumable. */
  readonly signal: NodeJS.Signals;
  /**
   * How long the core waits for the session to be gone from the host,
   * in milliseconds, before it kills the session there.
   */
  readonly boundMs: number;
}

/**
 * How the core interrupts the turn of one of the driver's sessions, as
 * data the core carries out: what stops the turn, by what the session
 * waits on, and how long the core waits for the session to be `idle`
 * after it. The core decides from the session's state whether there is a
 * turn to stop; the driver says how its agent stops one.
 */
export interface SessionInterrupting {
  /** What stops the turn of a `busy` session. */
  readonly busy: KeysInterrupt;
  /**
   * How long the core waits, in milliseconds, for the session to be
   * `idle` once it stopped the turn: past it, the interrupt fails
   * `interrupt-unconfirmed`.
   */
  readonly boundMs: number;
}

/** A turn stopped by keys pressed in the session's terminal. */
export interface KeysInterrupt {
  /** The keys, by the names the session host takes, pressed in one write. */
  readonly keys: readonly string[];
}

/** The agent's input box, as its screen shows it. */
export interface InputBox {
  /** The text in the box, its lines joined by `\n`: empty when the box is. */
  readonly text: string;
}

/** What became of a prompt a driver typed. */
export type TypingOutcome =
  /** The agent took it: a hook carried it. */
  | 'taken'
  /** It did not, the box cleared and the person's draft put back: `prompt-not-taken`. */
  | 'not-taken'
  /**
   * The driver found no input box it could type into: a dialog, a panel,
   * an entry the person recalled from the history, or a box that did not
   * act as one. It typed nothing more but to put the person's draft back,
   * which is back, or was never taken out of the box; the send fails
   * `wrong-state` with the state the session is in.
   */
  | 'no-input-box'
  | DraftLeft;

/**
 * What became of a prompt whose typing stopped with the person's draft out
 * of the input box, and no box shown to put it back into: the driver typed
 * nothing more, since a key could answer what is drawn over the box. The
 * send fails `wrong-state` with the state the session is in, its message
 * saying where the draft is.
 */
export interface DraftLeft {
  /** Where the person's draft is, and how the person brings it back: a sentence. */
  readonly draftLeft: string;
}

/** What a terminal shows at one moment: its rows as text, and where its cursor is. */
export type TerminalScreen = Pick<Screen, 'text' | 'cursor'>;

/**
 * Why a write of a prompt being typed was refused: the session no longer
 * showed its input box, or its hooks told of something else than the
 * prompt's own turn. Nothing of the write was written.
 */
export class TypingStoppedError extends Error {
  override readonly name = 'TypingStoppedError';
}

/**
 * The writes through which a driver puts the person's draft back once the
 * typing stopped, and the screen it reads meanwhile.
 */
export type DraftTerminal = Pick<TypingTerminal, 'typeText' | 'pressKeys' | 'readScreen'>;

/**
 * The writes through which a driver clears the agent's input box, and the
 * screen it reads meanwhile: each checked by the core, as a typing's are.
 */
export type ClearingTerminal = Pick<TypingTerminal, 'pressKeys' | 'readScreen'>;

/** What became of an input box a driver cleared. */
export type InputBoxClearing =
  /** The box is empty. */
  | 'cleared'
  /** No input box showed, before a key or after one: a dialog drawn in its place, or none. */
  | 'no-input-box'
  /**
   * The keys did not empty the box: two in a row changed nothing on it,
   * or as many as its rows take changed it but left text in it.
   */
  | 'not-emptied';

/**
 * A live session's terminal, as a driver types a prompt into it through the
 * core. The core holds the keys of the page's terminals for that session
 * while the driver types, and checks before every write that the session
 * still shows its input box and nothing waits for a person (no ask, no
 * dialog): once a check fails, the write and every later one reject with
 * {@link TypingStoppedError} and write nothing, and the core fails the send
 * with the state the session is in. The driver may then put the person's
 * draft back through {@link restoring}.
 */
export interface TypingTerminal {
  /**
   * Types text literally, in one write: never read as the names of keys.
   *
   * @param text - The text; a driver keeps each write small enough that the
   * agent reads it as typing, not as a paste.
   */
  typeText(text: string): Promise<void>;
  /**
   * Presses named keys, in order, in one write.
   *
   * @param keys - Key names as the session host takes them (`Enter`,
   * `Down`, `M-Enter`, `C-e`, `C-u`, `C-y`, `M-y`, `BSpace`).
   */
  pressKeys(keys: readonly string[]): Promise<void>;
  /**
   * Reads what the terminal shows, its rows as text and where its cursor
   * is; a person's scrolling back is left first.
   */
  readScreen(): Promise<TerminalScreen>;
  /**
   * Waits for the agent to take a prompt: a prompt taken since the driver
   * began typing counts, even before this call.
   *
   * @param prompt - The text it must take, as the agent will carry it: what
   * the driver typed, trailing whitespace left out.
   * @param withinMs - How long to wait, in milliseconds.
   * @returns `true` once the agent took that prompt; `false` when it took
   * none within the time.
   */
  promptTaken(prompt: string, withinMs: number): Promise<boolean>;
  /**
   * The terminal through which the driver puts the person's draft back
   * once the typing stopped: whatever turn the hooks told of, a write is
   * taken while the session is heard, the agent has used no tool since the
   * typing began (a tool may ask, its dialog drawn over the box a moment
   * later, where a key could answer it), and the screen shows the input box.
   * Once one is refused with
   * {@link TypingStoppedError}, every later one is, and the typing's end
   * refuses them all.
   */
  readonly restoring: DraftTerminal;
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
  /** The oldest and the newest versions of the agent its contract tests ran on. */
  readonly testedRange: TestedRange;
  /**
   * Reads the version of the agent a launch with this environment would run.
   *
   * @param environment - The environment the launch starts from: its `PATH` finds the agent.
   * @returns The version and how it stands against {@link testedRange}, or
   * that no agent was found, or that the one found cannot be run, and why
   * (a failure a launch refuses with `agent-not-found`, never an error of
   * its own).
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
   * Checks the environment launches start from for what would keep the
   * driver from confining its agent (for Claude Code, a configuration
   * folder or a home its deny rules could miss). `createCockpit` refuses
   * such an environment; the driver's `launch` refuses it again, read anew.
   *
   * @param environment - The environment a launch would start from.
   * @returns Every issue found, each with an empty path: the environment is
   * no option; none when it fits.
   */
  environmentIssues(environment: Readonly<Record<string, string>>): Promise<readonly Issue[]>;
  /**
   * Tells how far a session acts beyond the cockpit's lines without
   * asking: how far its commands reach the network, and whether its file
   * tools write unasked; the app's options, with a job's part laid over
   * them.
   *
   * @param part - The job's driver part, checked; none for the app's own options.
   * @returns The session's network.
   */
  networkOf(part?: DriverPart): SessionNetwork;
  /**
   * Reads the agent's screen, as the terminal shows it in text: where to
   * type, and what waits for a person in the terminal.
   *
   * @param text - The screen, line by line.
   * @returns What it shows.
   */
  readScreen(text: string): ScreenReading;
  /** The screen's signs of the agent's state, where nothing else tells it: see {@link ScreenStateSigns}. */
  readonly screenStateSigns: ScreenStateSigns;
  /**
   * Reads the agent's input box from its screen, while a prompt is typed:
   * the core checks it before every write.
   *
   * @param text - The screen, line by line.
   * @returns The box and its text; `undefined` when the screen shows
   * anything else over it (a dialog, a menu, an ask) or none.
   */
  readInputBox(text: string): InputBox | undefined;
  /**
   * Types a prompt into the input box of a live session, keeping the
   * person's draft: stashed before, put back after. Each write goes through
   * the terminal, which the core checks; the driver awaits the agent's
   * confirmation, pressing Enter again as its agent needs. A write the
   * terminal refuses stops the typing: the driver puts the draft back
   * through the terminal's `restoring` writes, or says where it is.
   *
   * @param prompt - The prompt, at most the cockpit's limit.
   * @param terminal - The session's terminal, through the core.
   * @returns Whether the agent took it, and where the draft is when it could not be put back.
   * @throws What the terminal rejects with, but {@link TypingStoppedError}.
   */
  typePrompt(prompt: string, terminal: TypingTerminal): Promise<TypingOutcome>;
  /**
   * Clears the agent's input box, the cursor at the end of its text: what
   * an early Esc put back there once {@link ScreenStateSigns.promptWithdrawn}
   * read it. It presses nothing on a box already empty, or where no box
   * shows; it stops after a bounded number of keys, as many as the box's
   * rows take, and says so. Each write goes through the terminal, which the
   * core checks.
   *
   * @param terminal - The session's terminal, through the core.
   * @returns Whether the box is empty, showed none, or was not emptied.
   * @throws What the terminal rejects with, {@link TypingStoppedError} among it.
   */
  clearInputBox(terminal: ClearingTerminal): Promise<InputBoxClearing>;
  /**
   * Tells whether a first prompt can be passed at launch: else the core
   * launches the agent with none and types the prompt once it is ready.
   *
   * @param prompt - The prompt, at most the cockpit's limit.
   * @returns `true` when it fits the agent's command line.
   */
  promptFitsLaunch(prompt: string): boolean;
  /**
   * Gives what of the driver's would reach a launch with a job's part, as
   * data the core records and compares.
   *
   * @param part - The job's driver part, checked; none for the app's own options.
   * @returns The settings.
   */
  launchSettings(part?: DriverPart): DriverSettings;
  /** How the core ends one of the driver's sessions gracefully. */
  readonly ending: SessionEnding;
  /** How the core interrupts the turn of one of the driver's sessions. */
  readonly interrupting: SessionInterrupting;
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
   * Follows what the agent of a live session tells outside its hooks, such
   * as an interruption only its transcript records: from now on, or from
   * the conversation's start when it is known to be new.
   *
   * @param conversation - The session's conversation, as it was launched or
   * moved to, and whether it is new.
   * @param report - Receives what it tells, as a hook's events are read.
   * @returns A function that stops following: nothing is reported after it.
   */
  follow(
    conversation: FollowedConversation,
    report: (events: readonly DriverEvent[]) => void,
  ): () => void;
  /**
   * Tells whether the agent still keeps a conversation, so that an ended
   * session can say whether it may resume.
   *
   * @param conversation - The conversation, as it was launched.
   * @returns `true` when the agent could resume it.
   */
  canResume(conversation: Conversation): Promise<boolean>;
}
