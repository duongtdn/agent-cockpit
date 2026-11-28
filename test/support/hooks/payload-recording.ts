import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { ROOT_NAME_PREFIX } from '../real-agent/environment.ts';

/**
 * The hook payloads of the real agent, as the contract suite records them
 * and the tests that need one read them back (`recorded-hooks.ts`): for
 * each event, each shape seen, with one example whose run-specific values
 * are placeholders. They are what the fake agent fires and what the unit
 * tests of the driver read, so that neither is written by hand.
 */

/** The variable that turns the recording on, in a run of the contract suite: `1`. */
export const RECORDING_VARIABLE = 'RECORD_HOOK_PAYLOADS';

/** The file the recorded payloads are kept in, under version control. */
export const RECORDED_PAYLOADS_FILE = fileIn('../../fixtures/hooks/claude-code.json');

/** Where each worker of a recording run writes what it saw, merged at the end of the run. */
export const PARTIAL_PAYLOADS_FOLDER = fileIn('../../../test-results/hook-payloads');

function fileIn(relative: string): string {
  return new URL(relative, import.meta.url).pathname;
}

/** One shape of an event's payload, with one example of it. */
export interface RecordedShape {
  /** A short label of what tells this shape from the event's others. */
  readonly shape: string;
  /** The example, its run-specific values made placeholders. */
  readonly payload: Record<string, unknown>;
}

/** The recorded payloads: the agent's version they were recorded of, and each event's shapes. */
export interface RecordedPayloads {
  readonly version: string;
  readonly payloads: Readonly<Record<string, readonly RecordedShape[]>>;
}

/** The placeholders of a recorded payload, each for a value that is the run's own. */
export const PLACEHOLDERS = {
  sessionId: '{{session_id}}',
  transcriptPath: '{{transcript_path}}',
  cwd: '{{cwd}}',
  root: '{{root}}',
  rootName: '{{root_name}}',
} as const;

/**
 * The fields whose value tells a variant of an event apart from another of
 * the same fields: how a session started or ended, what a turn failed on,
 * what started a compaction, which tool a call is of.
 */
const TELLING_FIELDS: readonly string[] = [
  'source',
  'reason',
  'error',
  'trigger',
  'tool_name',
  'notification_type',
];

/** Tells whether this run records the payloads it sees. */
export function isRecording(): boolean {
  return process.env[RECORDING_VARIABLE] === '1';
}

/** The identities of the shapes this worker already wrote: each is written once. */
const written = new Set<string>();

/**
 * Notes a hook payload that a test's receiver or driver read, when the run
 * records them: its run-specific values made placeholders, written once per
 * shape to this worker's file.
 *
 * @param payload - The payload as the agent sent it; anything that is no
 * payload of a hook event is left alone.
 */
export function recordHookPayload(payload: unknown): void {
  if (!isRecording() || !isPayload(payload)) return;
  const normalized = withPlaceholders(payload);
  const identity = identityOf(normalized);
  if (written.has(identity)) return;
  written.add(identity);
  mkdirSync(PARTIAL_PAYLOADS_FOLDER, { recursive: true });
  appendFileSync(
    join(PARTIAL_PAYLOADS_FOLDER, `${process.pid}-${threadId}.jsonl`),
    `${JSON.stringify(normalized)}\n`,
  );
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.hook_event_name === 'string';
}

/**
 * Makes the run's own values of a payload placeholders, wherever they
 * appear in it: its session's id, transcript and folder, then any path
 * under the run's temporary root, then the root's name where the agent
 * built another name of it (a project folder's).
 */
function withPlaceholders(payload: Record<string, unknown>): Record<string, unknown> {
  const exact: [string, string][] = [];
  for (const [field, placeholder] of [
    ['transcript_path', PLACEHOLDERS.transcriptPath],
    ['cwd', PLACEHOLDERS.cwd],
    ['session_id', PLACEHOLDERS.sessionId],
  ] as const) {
    const value = payload[field];
    if (typeof value === 'string' && value !== '') exact.push([value, placeholder]);
  }
  const root = new RegExp(
    `${escaped(realpathSync(tmpdir()))}/${ROOT_NAME_PREFIX}[A-Za-z0-9]+`,
    'g',
  );
  const rootName = new RegExp(`${ROOT_NAME_PREFIX}[A-Za-z0-9]+`, 'g');
  return mapStrings(payload, (text) => {
    let replaced = text;
    for (const [value, placeholder] of exact) replaced = replaced.split(value).join(placeholder);
    return replaced.replace(root, PLACEHOLDERS.root).replace(rootName, PLACEHOLDERS.rootName);
  }) as Record<string, unknown>;
}

/** Gives a text as a regular expression's source that matches it alone. */
export function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Gives a copy of a value with each string in it, keys left alone, made
 * anew by a function.
 */
export function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)]),
    );
  }
  return value;
}

/** What makes two payloads one shape: the event, the fields, and the values that tell variants apart. */
function identityOf(payload: Record<string, unknown>): string {
  return JSON.stringify([payload.hook_event_name, Object.keys(payload).sort(), tellingOf(payload)]);
}

/**
 * The fields that list tasks, told apart by the kinds of task they list: a
 * turn that ended with none running in the background, a shell, a subagent.
 */
const TASK_LISTS: readonly string[] = ['background_tasks'];

/**
 * The fields that list a batch's calls, told apart by how the calls ended:
 * a batch whose call the person refused with a text in the terminal, or
 * whose call the hook denied with no message (no hook tells of either call
 * but the batch), from one whose calls ran. A call denied with a message
 * has that message for its result, and is told from one that ran by
 * nothing in the batch.
 */
const CALL_LISTS: readonly string[] = ['tool_calls'];

/**
 * How the agent's result of a call the person refused begins, as a batch's
 * call carries it. A contract row checks it, so that a version that words
 * it otherwise fails there rather than recording a refused batch as one
 * that ran.
 */
export const REFUSED_CALL = "The user doesn't want to proceed with this tool use.";

/**
 * The agent's result of a call the hook denied with no message, as a
 * batch's call carries it. A contract row checks it, as {@link REFUSED_CALL}.
 */
export const DENIED_BY_HOOK = 'Permission denied by hook';

function tellingOf(payload: Record<string, unknown>): [string, unknown][] {
  const values = TELLING_FIELDS.filter((field) => field in payload).map(
    (field): [string, unknown] => [field, payload[field]],
  );
  const lists = [
    ...TASK_LISTS.map((field): [string, string] => [field, taskKinds(payload[field])]),
    ...CALL_LISTS.map((field): [string, string] => [field, callOutcomes(payload[field])]),
  ].filter(([, kinds]) => kinds !== '');
  return [...values, ...lists];
}

/** The kinds of the tasks a list holds, each once, in order: `shell`, `subagent`, or none. */
function taskKinds(list: unknown): string {
  if (!Array.isArray(list)) return '';
  const kinds = list.map((task) => (isRecord(task) ? String(task.type) : typeof task));
  return [...new Set(kinds)].sort().join('+');
}

/** How the calls a list holds ended, each once, sorted: `denied`, `ran`, `refused`, joined by `+`; none for no list. */
function callOutcomes(list: unknown): string {
  if (!Array.isArray(list)) return '';
  const outcomes = list.map((call) => callOutcome(isRecord(call) ? call.tool_response : undefined));
  return [...new Set(outcomes)].sort().join('+');
}

/** How a batch's call ended, as its result tells. */
export type CallOutcome = 'ran' | 'refused' | 'denied';

/**
 * Tells how a batch's call ended from its result: refused in the terminal
 * with a text, denied by the hook with no message, or ran.
 *
 * @param result - The call's `tool_response`, as the batch carries it.
 */
export function callOutcome(result: unknown): CallOutcome {
  const text = String(result);
  if (text.startsWith(REFUSED_CALL)) return 'refused';
  return text === DENIED_BY_HOOK ? 'denied' : 'ran';
}

/** Removes what an earlier recording run left of its workers' files. */
export function clearPartialPayloads(): void {
  rmSync(PARTIAL_PAYLOADS_FOLDER, { recursive: true, force: true });
}

/**
 * Reads what the workers of a recording run wrote, and the payloads
 * recorded before, and gives them merged: the shapes recorded before of the
 * same version kept with their example, a new shape added, all of them
 * recorded anew for another version.
 *
 * @param version - The version of the agent the run drove.
 * @param before - The payloads recorded before, if any.
 * @returns The merged payloads, each event's shapes labeled and in a stable order.
 */
export function mergePartialPayloads(
  version: string,
  before: RecordedPayloads | undefined,
): RecordedPayloads {
  const byIdentity = new Map<string, Record<string, unknown>>();
  if (before?.version === version) {
    for (const shapes of Object.values(before.payloads)) {
      for (const { payload } of shapes) byIdentity.set(identityOf(payload), payload);
    }
  }
  const fresh = partialPayloads().sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  for (const payload of fresh) {
    const identity = identityOf(payload);
    if (!byIdentity.has(identity)) byIdentity.set(identity, payload);
  }
  return { version, payloads: labeled([...byIdentity.values()]) };
}

function partialPayloads(): Record<string, unknown>[] {
  if (!existsSync(PARTIAL_PAYLOADS_FOLDER)) return [];
  return readdirSync(PARTIAL_PAYLOADS_FOLDER).flatMap((name) =>
    readFileSync(join(PARTIAL_PAYLOADS_FOLDER, name), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

/**
 * Groups payloads by event and labels each shape by what tells it from the
 * event's others: the telling fields' values, then each field that not
 * every shape of the event has.
 */
function labeled(payloads: readonly Record<string, unknown>[]): Record<string, RecordedShape[]> {
  const events = new Map<string, Record<string, unknown>[]>();
  for (const payload of payloads) {
    const event = payload.hook_event_name as string;
    events.set(event, [...(events.get(event) ?? []), payload]);
  }
  const result: Record<string, RecordedShape[]> = {};
  for (const event of [...events.keys()].sort()) {
    const shapes = events.get(event) as Record<string, unknown>[];
    const common = Object.keys(shapes[0] as object).filter((key) =>
      shapes.every((shape) => key in shape),
    );
    result[event] = shapes
      .map((payload) => ({ shape: labelOf(payload, common), payload }))
      .sort((a, b) => a.shape.localeCompare(b.shape));
  }
  return result;
}

function labelOf(payload: Record<string, unknown>, common: readonly string[]): string {
  const telling = tellingOf(payload).map(([field, value]) => `${field}=${String(value)}`);
  const beyond = Object.keys(payload)
    .filter((key) => !common.includes(key))
    .sort()
    .map((key) => `+${key}`);
  const parts = [...telling, ...beyond];
  return parts.length === 0 ? 'plain' : parts.join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
