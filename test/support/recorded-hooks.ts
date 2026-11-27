import { readFileSync } from 'node:fs';
import {
  mapStrings,
  PLACEHOLDERS,
  RECORDED_PAYLOADS_FILE,
  type RecordedPayloads,
} from './hooks/payload-recording.ts';

/**
 * Reads the real agent's hook payloads that the contract suite recorded
 * (`RECORD_HOOK_PAYLOADS=1 pnpm test:contract`): what the fake agent fires
 * and what the unit tests of the driver read, never a payload written by hand.
 */

/** The run's own values a recorded payload is filled with. */
export interface PayloadValues {
  /** The conversation's id. */
  readonly sessionId: string;
  /** The conversation's transcript. */
  readonly transcriptPath: string;
  /** The folder the session works in. */
  readonly cwd: string;
  /** The folder the run's other files are under. */
  readonly root: string;
}

/** The values of a session that is no real one's, for a test that reads payloads only. */
export const SAMPLE_VALUES: PayloadValues = {
  sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
  transcriptPath: '/run/config/projects/-run-work/6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11.jsonl',
  cwd: '/run/work',
  root: '/run',
};

/** Which recorded shape of an event: fields its example has, with these values, or a test of it. */
export type ShapeChoice =
  | Readonly<Record<string, unknown>>
  | ((payload: Readonly<Record<string, unknown>>) => boolean);

let loaded: RecordedPayloads | undefined;

/**
 * Gives the recorded payloads, read once.
 *
 * @returns The agent's version they were recorded of, and each event's shapes.
 */
export function recordedPayloads(): RecordedPayloads {
  loaded ??= JSON.parse(readFileSync(RECORDED_PAYLOADS_FILE, 'utf8')) as RecordedPayloads;
  return loaded;
}

/**
 * Gives a payload the real agent sent for an event, as recorded, filled
 * with a session's values.
 *
 * @param event - The event's name, such as `Stop`.
 * @param where - Which of the event's shapes: the first whose example has
 * each of these fields with the same value, or passes this test; the first
 * recorded by default.
 * @param values - The values that fill the placeholders; {@link SAMPLE_VALUES} by default.
 * @returns A copy of the example, the test's to change.
 * @throws `Error` naming the event and its recorded shapes when no recorded
 * example fits: the contract suite never saw it, and a payload is not invented.
 */
export function recordedPayload(
  event: string,
  where: ShapeChoice = {},
  values: PayloadValues = SAMPLE_VALUES,
): Record<string, unknown> {
  const shapes = recordedPayloads().payloads[event] ?? [];
  const found = shapes.find(({ payload }) => fits(payload, where));
  if (found === undefined) {
    const recorded = shapes.map(({ shape }) => shape).join('; ') || 'none';
    throw new Error(
      `No recorded ${event} payload fits ${describe(where)}; recorded shapes: ${recorded}`,
    );
  }
  return filled(found.payload, values);
}

function fits(payload: Readonly<Record<string, unknown>>, where: ShapeChoice): boolean {
  if (typeof where === 'function') return where(payload);
  return Object.entries(where).every(
    ([field, value]) => JSON.stringify(payload[field]) === JSON.stringify(value),
  );
}

function describe(where: ShapeChoice): string {
  return typeof where === 'function' ? 'the test given' : JSON.stringify(where);
}

/** Fills a recorded payload's placeholders with a session's values. */
function filled(payload: Record<string, unknown>, values: PayloadValues): Record<string, unknown> {
  const rootName = values.root.split('/').at(-1) ?? '';
  return mapStrings(payload, (text) =>
    text
      .replaceAll(PLACEHOLDERS.transcriptPath, values.transcriptPath)
      .replaceAll(PLACEHOLDERS.cwd, values.cwd)
      .replaceAll(PLACEHOLDERS.sessionId, values.sessionId)
      .replaceAll(PLACEHOLDERS.root, values.root)
      .replaceAll(PLACEHOLDERS.rootName, rootName),
  ) as Record<string, unknown>;
}
