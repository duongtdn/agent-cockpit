import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * What the running test saw, in order and in time: each hook read, each
 * screen of a session as it changed, each state a session went through. It
 * is written out only when the test fails (`timeline-setup.ts`), so that a
 * red run on a machine nobody watches — CI's — can be read afterwards.
 */

/** One thing seen, at a moment of the test. */
export interface Moment {
  /** Milliseconds since the test began. */
  readonly at: number;
  readonly kind: 'hook' | 'screen' | 'state' | 'keys';
  /** Whose it is: a session's name or key. */
  readonly of: string;
  readonly detail: string;
}

let began = Date.now();
let moments: Moment[] = [];
const lastScreens = new Map<string, string>();

/** Starts the running test's timeline, empty. */
export function beginTimeline(): void {
  began = Date.now();
  moments = [];
  lastScreens.clear();
}

/** Notes a hook a test's receiver or driver read. */
export function noteHook(of: string, payload: unknown): void {
  note('hook', of, JSON.stringify(payload));
}

/** Notes what was typed or pressed into a session's terminal. */
export function noteKeys(of: string, keys: string): void {
  note('keys', of, keys);
}

/** Notes a state a session reached. */
export function noteState(of: string, state: string): void {
  note('state', of, state);
}

/** Notes a session's screen, when it is not the one noted last for that session. */
export function noteScreen(of: string, screen: string): void {
  if (lastScreens.get(of) === screen) return;
  lastScreens.set(of, screen);
  note('screen', of, screen);
}

function note(kind: Moment['kind'], of: string, detail: string): void {
  moments.push({ at: Date.now() - began, kind, of, detail });
}

/** The timeline so far, as a text a person reads: one moment after another, a screen whole. */
export function timelineText(): string {
  return moments
    .map(({ at, kind, of, detail }) => {
      const head = `+${String(at).padStart(6)} ms  ${kind.padEnd(6)} ${of}`;
      return kind === 'screen'
        ? `${head}\n${detail.replace(/^/gmu, '    | ')}`
        : `${head}  ${detail}`;
    })
    .join('\n');
}

/**
 * Writes the timeline of a failed test under `test-results/timelines/`,
 * named after its file and title.
 *
 * @param repository - The repository's root.
 * @param file - The test's file.
 * @param title - The test's full title.
 * @returns The path written, or `undefined` when nothing was seen.
 */
export function writeTimeline(repository: string, file: string, title: string): string | undefined {
  if (moments.length === 0) return undefined;
  const folder = join(repository, 'test-results', 'timelines');
  mkdirSync(folder, { recursive: true });
  const name = `${relative(repository, file)} ${title}`
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .slice(0, 180);
  const path = join(folder, `${name}.txt`);
  writeFileSync(path, `${relative(repository, file)} > ${title}\n\n${timelineText()}\n`);
  return path;
}
