/**
 * The state of a unit of work's session: `starting` (the agent is launching),
 * `idle` (it waits for a prompt), `busy` (it works on a turn), `waiting` (it
 * waits for a person: an ask, a channel request or something in the
 * terminal), `ended` (no agent runs).
 */
export type SessionState = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended';

/**
 * A dialog the agent shows in its terminal before it takes a first prompt:
 * trusting the folder, confirming a mode that skips permissions, the first
 * run's choices, or logging in.
 */
export type StartupDialog = 'trust-folder' | 'bypass-permissions' | 'onboarding' | 'login';

/**
 * One thing a `waiting` session waits for: an ask of the agent's (`ask`), a
 * channel request (`request`), or something only the terminal can answer
 * (`terminal`).
 */
export interface Pending {
  /** What kind of thing waits. */
  readonly kind: 'ask' | 'request' | 'terminal';
  /** The id of the ask or the channel request, to answer it by. */
  readonly id?: string;
  /** The start-up dialog shown in the terminal, when it is a known one. */
  readonly dialog?: StartupDialog;
}

/**
 * Why a session ended: the app ended or removed it (`app`), the idle timeout
 * did (`idle-timeout`), the cap on live sessions did (`session-cap`), a run
 * with other settings or a fresh start replaced it (`restarted`), the agent
 * exited by itself (`agent-exit`), the person left a start-up dialog by "No"
 * or Esc (`declined`), the cockpit could not observe it (`unobservable`), or
 * its process went otherwise, unexpectedly (`lost`). An app tells the person
 * what happened, and whether to act, from this alone.
 */
export type EndReason =
  | 'app'
  | 'idle-timeout'
  | 'session-cap'
  | 'restarted'
  | 'agent-exit'
  | 'declined'
  | 'unobservable'
  | 'lost';

/** What every listed session carries, whatever its state. */
interface SessionBase {
  /** The key of its unit of work, `[a-z0-9-]+`. */
  readonly key: string;
  /**
   * When it entered its state, as an ISO 8601 date and time in UTC. A string,
   * not a `Date`, so that the server and the browser hold the same value
   * across the wire.
   */
  readonly since: string;
  /**
   * What the cockpit keeps of its unit of work: the conversation a resume
   * takes up, the earlier ones, the history of its runs and opens.
   */
  readonly record?: SessionRecord;
}

/**
 * One run or open of a unit of work, as its record keeps it: what was
 * asked, with which job and arguments, when, and what it did.
 */
export interface HistoryEntry {
  /** What the app asked: a run of a job, or an open of the key. */
  readonly operation: 'run' | 'open';
  /** The job: the run's own, or for an open the last run's, whose settings it launched with. */
  readonly jobId: string;
  /**
   * The job's arguments as the run was given them, the schema's input: a
   * later open or send reads them again with every check of a run.
   */
  readonly args: unknown;
  /** When it was asked, as an ISO 8601 date and time in UTC. */
  readonly at: string;
  /** What it did. */
  readonly action: 'started' | 'resumed' | 'sent';
  /** Why, when the action has a reason: those of {@link RunResult} and {@link OpenResult}. */
  readonly reason?: 'fresh' | 'fresh-on-request' | 'conversation-gone' | 'settings-changed';
  /** The conversation it acted in. */
  readonly conversationId: string;
}

/**
 * What the cockpit keeps of a unit of work until the app removes it: the
 * conversation it continues, those it worked in before, and its history.
 */
export interface SessionRecord {
  /** The conversation a resume takes up: the last one the agent worked in. */
  readonly conversationId: string;
  /**
   * The conversations it worked in before, oldest first: left by a fresh
   * start, a conversation the agent no longer kept, or the agent's own move
   * to a new one (Claude Code's `/clear`).
   */
  readonly earlierConversations: readonly string[];
  /** Its runs and opens that did something, oldest first. */
  readonly history: readonly HistoryEntry[];
}

/** A session whose agent was launched and cannot take input yet. */
export interface StartingSession extends SessionBase {
  /** Its state. */
  readonly state: 'starting';
}

/** A session whose agent works on a turn. */
export interface BusySession extends SessionBase {
  /** Its state. */
  readonly state: 'busy';
}

/** A session that waits for a person. */
export interface WaitingSession extends SessionBase {
  /** Its state. */
  readonly state: 'waiting';
  /** Everything it waits for: at least one entry. */
  readonly pending: readonly Pending[];
}

/**
 * Why the last turn failed, when it ended on an error of the model's API
 * rather than with an answer: the provider's side (`server`, an overload
 * included), a rate limit (`rate-limit`), or anything else (`other`); with
 * the agent's own text.
 */
export interface TurnError {
  /** What kind of failure, for the app to act on. */
  readonly kind: 'server' | 'rate-limit' | 'other';
  /** What the agent said of it, in its own words. */
  readonly message: string;
}

/**
 * A task the agent runs in the background of a session, a subagent for one,
 * which goes on while the session is `idle`.
 */
export interface BackgroundTask {
  /** The task's id, as the agent names it: an ask the task raises carries it. */
  readonly id: string;
  /** What kind of task, in the agent's terms (a subagent's type, such as `general-purpose`). */
  readonly type: string;
  /** What the task was given to do, when the agent says. */
  readonly description?: string;
}

/** A session whose agent can take a prompt. */
export interface IdleSession extends SessionBase {
  /** Its state. */
  readonly state: 'idle';
  /** The last message of the turn that ended, if any: absent when no turn ran yet. */
  readonly lastMessage?: string;
  /** Why the turn that just ended failed, when it did; a later turn clears it. */
  readonly error?: TurnError;
  /** The tasks still running in the background; absent when none runs. */
  readonly backgroundTasks?: readonly BackgroundTask[];
}

/** A session whose agent's process is gone. */
export interface EndedSession extends SessionBase {
  /** Its state. */
  readonly state: 'ended';
  /** Whether its conversation can be resumed: the agent still keeps it. */
  readonly canResume: boolean;
  /** Why it ended. */
  readonly reason: EndReason;
  /**
   * With `declined`: the start-up dialog the person left, when the driver
   * knew it; the next launch meets the same dialog.
   */
  readonly dialog?: StartupDialog;
}

/**
 * A session as the app and the browser see it: its key, its state, since
 * when, and what that state carries. A union on `state`, so that
 * `switch (session.state)` narrows to what the state carries and nothing
 * else.
 */
export type Session = StartingSession | BusySession | WaitingSession | IdleSession | EndedSession;

/** A new conversation was started for the key. */
interface StartedResult<Reason extends string> {
  /** A new conversation was started. */
  readonly action: 'started';
  /**
   * Why a new one, when the key had a conversation: the job asks for a
   * fresh start (`fresh`), the caller did (`fresh-on-request`), or the
   * agent no longer keeps it (`conversation-gone`).
   */
  readonly reason?: Reason;
  /** The state the session left `starting` for. */
  readonly state: SessionState;
  /**
   * The background tasks stopped with the live session a fresh start on
   * request ended first; absent when none ran.
   */
  readonly stoppedTasks?: readonly BackgroundTask[];
}

/** A live session took the prompt. */
interface SentResult {
  /** The prompt was typed into the live session, which took it. */
  readonly action: 'sent';
  /** The state the session is in. */
  readonly state: SessionState;
}

/**
 * What a run did, and the state it left the session in. A union on
 * `action`: each action has only the reasons that can come with it.
 */
export type RunResult =
  | StartedResult<'fresh' | 'fresh-on-request' | 'conversation-gone'>
  | {
      /** The key's conversation was resumed with the run's prompt. */
      readonly action: 'resumed';
      /** On an `idle` session launched with other settings: it was restarted with the run's. */
      readonly reason?: 'settings-changed';
      /** The state the session left `starting` for. */
      readonly state: SessionState;
      /**
       * The background tasks stopped with the session a restart on other
       * settings ended first; absent when none ran.
       */
      readonly stoppedTasks?: readonly BackgroundTask[];
    }
  | SentResult
  | {
      /** A job without a prompt, on a live session: there was nothing to send. */
      readonly action: 'nothing-to-send';
      /** The state the session is in. */
      readonly state: SessionState;
    };

/**
 * What a send did, and the state it left the session in: typed into an
 * `idle` session (`sent`), or an `ended` one resumed with the prompt
 * (`resumed`), or started anew when the agent no longer kept its
 * conversation (`started`, `conversation-gone`).
 */
export type SendResult =
  | SentResult
  | {
      /** The key's conversation was resumed with the prompt. */
      readonly action: 'resumed';
      /** The state the session left `starting` for. */
      readonly state: SessionState;
    }
  | (StartedResult<'conversation-gone'> & { readonly reason: 'conversation-gone' });

/**
 * What an open did: an `ended` session resumed with no prompt
 * (`resumed`), a new conversation started (`started`: on request, or the
 * agent no longer kept the last), or nothing to open (`nothing-to-open`).
 */
export type OpenResult =
  | {
      /** The key's conversation was resumed, with no prompt. */
      readonly action: 'resumed';
      /** The state the session left `starting` for. */
      readonly state: SessionState;
    }
  | (StartedResult<'fresh-on-request' | 'conversation-gone'> & {
      readonly reason: 'fresh-on-request' | 'conversation-gone';
    })
  | {
      /** The session is live, or the key has no record: there was nothing to open. */
      readonly action: 'nothing-to-open';
      /** The state of the live session; absent for a key with no record. */
      readonly state?: SessionState;
    };

/** What a run takes beside its job and arguments. */
export interface RunOptions {
  /**
   * Starts a new conversation for the key, with the job's prompt, ending
   * its live session first; the old conversation stays in the record.
   * Without it, the job's own `fresh` decides on an `ended` session.
   */
  readonly fresh?: boolean;
}

/** What an open takes beside the key. */
export interface OpenOptions {
  /**
   * Starts a new conversation for the key, with no prompt and the settings
   * of its last run, ending its live session first; the old conversation
   * stays in the record.
   */
  readonly fresh?: boolean;
}

/** A key: lower-case ASCII letters, digits and `-`, at least one. */
const SESSION_KEY = /^[a-z0-9-]+$/;

/**
 * Tells whether a text can be a session's key. A key names a tmux session, a
 * folder of the state folder and a segment of the wire's paths, so it holds
 * only characters that are safe in all three, unencoded.
 *
 * @param text - What a job's `key` returned, or what a request named.
 * @returns `true` when the text is of the form `[a-z0-9-]+`.
 */
export function isSessionKey(text: string): boolean {
  return SESSION_KEY.test(text);
}
