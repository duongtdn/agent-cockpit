import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import type { TerminalScreen } from '../../src/server/driver.ts';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { findTranscript } from './transcript-files.ts';

/** An entry of a transcript: one line of its file, parsed. Its format is the agent's own. */
export type TranscriptEntry = Readonly<Record<string, unknown>>;

/** How a session was when it was last seen. */
export interface SessionEnd {
  /** The last screen read of the session; `undefined` when it was gone before any was. */
  readonly lastScreen: string | undefined;
}

/** A session of an agent, real or fake, in a terminal of its own. */
export interface AgentSession {
  /** The session's name on its host, for a message to tell it from the others. */
  readonly name: string;
  /** The conversation's id. */
  readonly id: string;
  /** Types text into the terminal, as a person would. */
  type(text: string): Promise<void>;
  /** Types text into the terminal in one write, as the driver types each of its own. */
  typeInOneWrite(text: string): Promise<void>;
  /** Presses keys, by the session host's names (`Enter`, `Escape`). */
  press(...keys: string[]): Promise<void>;
  /** Reads what the terminal shows. */
  screen(): Promise<string>;
  /** Reads what the terminal shows and where its cursor is. */
  screenWithCursor(): Promise<TerminalScreen>;
  /** Reads the conversation's transcript; empty while the agent has written none. */
  transcript(): TranscriptEntry[];
  /**
   * Gives the agent's process id.
   *
   * @throws Error when the session does not live.
   */
  processId(): Promise<number>;
  /** Tells whether the session lives: its terminal exists. */
  isLive(): Promise<boolean>;
  /**
   * Fulfilled once the session is gone, however it went: its agent exited,
   * at its launch too, it was killed, or the runner closed.
   */
  readonly ended: Promise<SessionEnd>;
}

/** Fast enough for a test, in writes too small to read as a paste. */
const TYPING = { chunkLength: 100, pauseMs: 5 };
/** How often a session is looked at, to know when it is gone and what it showed last. */
const WATCH_POLL_MS = 50;

/** What tells a session of a host from the others, and where its conversation is written. */
export interface SessionPlace {
  /** The session's name on its host. */
  readonly name: string;
  /** The conversation's id. */
  readonly id: string;
  /** The configuration folder of the agent, which holds its transcripts. */
  readonly configFolder: string;
}

/**
 * Gives a session that a host runs, for a test to drive and to read: its
 * screen is read from now on until it is gone, so that its end can tell
 * what it showed last.
 *
 * @param host - The host the session was started on.
 * @param place - See {@link SessionPlace}.
 * @returns The session.
 */
export function sessionOf(
  host: SessionHost,
  { name, id, configFolder }: SessionPlace,
): AgentSession {
  let lastScreen: string | undefined;
  const screenWithCursor = async () => {
    const { text, cursor } = await host.readScreen(name);
    lastScreen = text;
    return { text, cursor };
  };
  const screen = async () => (await screenWithCursor()).text;
  return {
    name,
    id,
    type: (text) => host.sendText(name, text, TYPING),
    typeInOneWrite: (text) =>
      host.sendText(name, text, { chunkLength: Math.max(1, Array.from(text).length), pauseMs: 0 }),
    press: (...keys) => host.sendKeys(name, keys),
    screen,
    screenWithCursor,
    transcript: () => readTranscript(configFolder, id),
    processId: async () => {
      const running = await host.processOf(name);
      if (running === undefined) throw new Error(`The session ${name} does not live.`);
      return running.pid;
    },
    isLive: () => host.isLive(name),
    ended: gone(host, name, screen).then(() => ({ lastScreen })),
  };
}

/**
 * Waits until a session is gone, reading its screen meanwhile: a session
 * host tells of no end, and a session that is gone shows nothing.
 */
async function gone(
  host: SessionHost,
  name: string,
  readScreen: () => Promise<unknown>,
): Promise<void> {
  // A host that cannot be asked has no session to show either.
  while (await host.isLive(name).catch(() => false)) {
    await readScreen().catch(() => undefined);
    await pause(WATCH_POLL_MS);
  }
}

function readTranscript(configFolder: string, sessionId: string): TranscriptEntry[] {
  const path = findTranscript(configFolder, sessionId);
  if (path === undefined) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptEntry);
}
