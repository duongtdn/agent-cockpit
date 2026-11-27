import { open, stat } from 'node:fs/promises';
import type { DriverEvent } from '../server/driver.js';
import { type TranscriptLookup, transcriptSearch } from './conversations.js';

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

/**
 * How Claude Code begins the entries it writes once a local command (one
 * run with no turn and no hook: `/clear`, `/context`, `/compact`) has run:
 * the caveat that opens its record (an interrupted `/compact` writes it
 * alone), then its output or its error.
 */
const COMMAND_END_TAGS: readonly { readonly tag: string; readonly entry: CommandEntry }[] = [
  { tag: '<local-command-caveat>', entry: 'caveat' },
  { tag: '<local-command-stdout>', entry: 'result' },
  { tag: '<local-command-stderr>', entry: 'result' },
];

/** Which of a local command's entries an entry is. */
type CommandEntry = Extract<DriverEvent, { type: 'command-done' }>['entry'];

/** How Claude Code begins the entry it writes for a command it does not know. */
const UNKNOWN_COMMAND = 'Unknown command: ';

const LINE_END = 0x0a;

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

/** A conversation's transcript to follow, and whether the conversation is known to be new. */
export interface FollowedTranscript extends TranscriptLookup {
  /**
   * Whether the conversation is known to be new: its transcript, all of it
   * the session's, is read from its start, however early the agent wrote
   * it (a `/clear` writes the command's end within a poll of its hook).
   */
  readonly isNew: boolean;
}

/**
 * Follows a conversation's transcript and reports what is written into it
 * that no hook tells: each interruption and each entry of a local
 * command's end, with when the agent recorded it. A conversation known to
 * be new is read from its start; another's earlier entries are not
 * reported, so that a resumed conversation's past is not told again. The
 * transcript may not exist yet: a new conversation writes it with its first
 * entry, and it is looked for as {@link transcriptSearch} does until found.
 * A transcript that shrank was written anew, and is read again from its
 * start.
 *
 * @param transcript - The conversation, where to look for it, and whether it is new.
 * @param report - Receives the events of each round that found any.
 * @returns The watch.
 */
export function followTranscript(
  transcript: FollowedTranscript,
  report: (events: readonly DriverEvent[]) => void,
): TranscriptWatch {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let path: string | undefined;
  let offset = 0;
  let unread: Buffer = Buffer.alloc(0);

  const find = transcriptSearch(transcript);

  async function begin(): Promise<void> {
    if (transcript.isNew) return;
    path = await find();
    if (path !== undefined) offset = (await stat(path)).size;
  }

  async function round(): Promise<void> {
    path ??= await find();
    if (path === undefined) return;
    const size = (await stat(path)).size;
    if (size < offset) {
      offset = 0;
      unread = Buffer.alloc(0);
    }
    if (size === offset) return;
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
    .map(parsed)
    .flatMap(eventsOfEntry);
  return { events, rest: unread.subarray(end) };
}

function eventsOfEntry(entry: unknown): DriverEvent[] {
  if (isInterruption(entry)) return [{ type: 'interrupted', ...recordedAt(entry) }];
  const commandEntry = commandEntryOf(entry);
  if (commandEntry !== undefined) {
    return [{ type: 'command-done', entry: commandEntry, ...recordedAt(entry) }];
  }
  return [];
}

/** When the agent recorded an entry, when the entry says: an `at` to spread into its event. */
function recordedAt(entry: unknown): { at?: string } {
  const { timestamp } = entry as { readonly timestamp?: unknown };
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  return Number.isNaN(at) ? {} : { at: new Date(at).toISOString() };
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

/**
 * Tells which of the entries Claude Code writes once a local command has
 * run this one is: a `user` or `system` entry of its own (a person's
 * prompt carries `promptSource`) whose text begins with the caveat's, the
 * output's or the error's tag, or the entry of an unknown command (its
 * result).
 *
 * @param entry - An entry of a transcript, parsed.
 * @returns Which, or `undefined` for an entry that records no local command's end.
 */
function commandEntryOf(entry: unknown): CommandEntry | undefined {
  if (!isRecord(entry) || entry.promptSource !== undefined) return undefined;
  if (entry.type === 'system' && typeof entry.content === 'string') {
    const { content } = entry;
    if (entry.subtype === 'informational') {
      return content.startsWith(UNKNOWN_COMMAND) ? 'result' : undefined;
    }
    return entry.subtype === 'local_command' ? commandEntryTagged(content) : undefined;
  }
  if (entry.type !== 'user' || !isRecord(entry.message)) return undefined;
  const { content } = entry.message;
  return typeof content === 'string' ? commandEntryTagged(content) : undefined;
}

/** Which command entry a text's opening tag makes it; `undefined` when it opens with none. */
function commandEntryTagged(text: string): CommandEntry | undefined {
  return COMMAND_END_TAGS.find(({ tag }) => text.startsWith(tag))?.entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
