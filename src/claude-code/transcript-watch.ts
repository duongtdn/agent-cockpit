import { open, stat } from 'node:fs/promises';
import type { DriverEvent } from '../server/driver.js';
import { findTranscript } from './conversations.js';

/**
 * How often a watched transcript is looked at. An interruption is written
 * within about 60 ms of the Esc; a quarter of a second more keeps its
 * `idle` within the second in which a session's other changes reach the
 * app's page, for one `stat` per round.
 */
export const TRANSCRIPT_POLL_MS = 250;

/**
 * What Claude Code writes into a conversation when a person interrupts a
 * turn, which no hook reports: while the agent writes, or while a tool call
 * is open.
 */
const INTERRUPTION_MARKERS: ReadonlySet<unknown> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

const LINE_END = 0x0a;

/** The conversation a watch follows. */
export interface WatchedTranscript {
  /** The agent's configuration folder, which holds its conversations. */
  readonly configFolder: string;
  /** The conversation's id. */
  readonly conversationId: string;
}

/** A watch of a transcript. */
export interface TranscriptWatch {
  /**
   * Resolves once the watch knows what the transcript held when it began:
   * what is written from then on is reported.
   */
  readonly begun: Promise<void>;
  /** Stops the watch: nothing is reported after it. */
  stop(): void;
}

/**
 * Follows a conversation's transcript and reports each interruption written
 * into it from now on: what the transcript held before is not reported, so
 * that a resumed conversation's earlier interruptions are not told again.
 * The transcript may not exist yet: a new conversation writes it with its
 * first prompt.
 *
 * @param transcript - The conversation.
 * @param report - Receives the events of each round that found any.
 * @returns The watch.
 */
export function followTranscript(
  transcript: WatchedTranscript,
  report: (events: readonly DriverEvent[]) => void,
): TranscriptWatch {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let path: string | undefined;
  let offset = 0;
  let unread: Buffer = Buffer.alloc(0);

  const find = () => findTranscript(transcript.configFolder, transcript.conversationId);

  async function begin(): Promise<void> {
    path = await find();
    if (path !== undefined) offset = (await stat(path)).size;
  }

  async function round(): Promise<void> {
    path ??= await find();
    if (path === undefined) return;
    const size = (await stat(path)).size;
    if (size <= offset) return;
    const read = await readBytes(path, offset, size);
    offset += read.length;
    const { events, rest } = eventsIn(Buffer.concat([unread, read]));
    unread = rest;
    if (events.length > 0 && !stopped) report(events);
  }

  function after(step: Promise<void>): void {
    // A transcript that cannot be read now is looked at again in the next round.
    void step
      .catch(() => {})
      .then(() => {
        if (!stopped) timer = setTimeout(() => after(round()), TRANSCRIPT_POLL_MS);
      });
  }

  const begun = begin();
  after(begun);
  return {
    begun: begun.catch(() => {}),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function readBytes(path: string, from: number, to: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(to - from);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/**
 * Reads the events in what was written into a transcript: one entry, as
 * JSON, a line. Cut at the last line end, so that a line, or a character,
 * written in two parts is read once whole.
 *
 * @param unread - What was written and not read yet.
 * @returns The events of its whole lines, in order, and what follows the
 * last of them, to read with what comes next. A line that is no JSON tells
 * nothing.
 */
export function eventsIn(unread: Buffer): { events: DriverEvent[]; rest: Buffer } {
  const end = unread.lastIndexOf(LINE_END) + 1;
  const events: DriverEvent[] = unread
    .subarray(0, end)
    .toString('utf8')
    .split('\n')
    .filter((line) => isInterruption(parsed(line)))
    .map(() => ({ type: 'interrupted' }));
  return { events, rest: unread.subarray(end) };
}

function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Tells an interruption marker: an entry of the agent's own, a `user`
 * message of text blocks — a person's prompt is a plain text, whatever it
 * says.
 *
 * @param entry - An entry of a transcript, parsed.
 * @returns `true` when it marks a turn the person interrupted.
 */
export function isInterruption(entry: unknown): boolean {
  if (!isRecord(entry) || entry.type !== 'user' || !isRecord(entry.message)) return false;
  const { content } = entry.message;
  return (
    Array.isArray(content) &&
    content.some(
      (block) => isRecord(block) && block.type === 'text' && INTERRUPTION_MARKERS.has(block.text),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
