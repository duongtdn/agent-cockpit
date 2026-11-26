/** A tmux version, as `tmux -V` names it. */
export interface TmuxVersion {
  /** The first number: `3` of `3.2a`. */
  readonly major: number;
  /** The second number: `2` of `3.2a`, `10` of `3.10`. */
  readonly minor: number;
  /**
   * Where the build stands toward its release: `next` is a development build
   * on the way to it (`next-3.5`), `candidate` a release candidate
   * (`3.3-rc`), `release` the release or one of its patches.
   */
  readonly stage: 'next' | 'candidate' | 'release';
  /** The patch letter of a release: `a` of `3.2a`; empty for none. */
  readonly patch: string;
  /** The version as tmux printed it, without the leading `tmux `. */
  readonly text: string;
}

/**
 * tmux names a release `3.2` or `3.2a`, a release candidate `3.3-rc`, and a
 * build of its development branch `next-3.5`. Other names (`master`,
 * OpenBSD's `openbsd-7.4`) tell nothing that can be ordered.
 */
const VERSION = /^tmux (next-)?(\d+)\.(\d+)([a-z]?)(-rc\d*)?$/;

/** A build before its release sorts before it, a development build first. */
const STAGE_RANK = { next: 0, candidate: 1, release: 2 } as const;

/**
 * Reads the version from what `tmux -V` printed.
 *
 * @param output - The command's output, with or without its line break.
 * @returns The version, or `undefined` when the output names none that can
 * be ordered.
 */
export function parseTmuxVersion(output: string): TmuxVersion | undefined {
  const match = VERSION.exec(output.trim());
  if (match === null) return undefined;
  const [whole, next, major = '', minor = '', patch = '', candidate] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    stage: next !== undefined ? 'next' : candidate !== undefined ? 'candidate' : 'release',
    patch,
    text: whole.slice('tmux '.length),
  };
}

/**
 * Orders two tmux versions: by their numbers (`3.10` after `3.9`), then a
 * development build before a release candidate before the release, then the
 * patch letters (`3.2` before `3.2a`).
 *
 * @returns A negative number when `one` is older, a positive one when it is
 * newer, zero when they are the same.
 */
export function compareTmuxVersions(one: TmuxVersion, other: TmuxVersion): number {
  return (
    one.major - other.major ||
    one.minor - other.minor ||
    STAGE_RANK[one.stage] - STAGE_RANK[other.stage] ||
    one.patch.localeCompare(other.patch)
  );
}

/** The oldest tmux the session host runs on: the oldest it was tested on. */
export const MINIMUM_TMUX_VERSION: TmuxVersion = {
  major: 3,
  minor: 2,
  stage: 'release',
  patch: 'a',
  text: '3.2a',
};

/**
 * Tells whether the session host runs on a tmux version: on
 * {@link MINIMUM_TMUX_VERSION} and everything after it.
 */
export function isSupportedTmuxVersion(version: TmuxVersion): boolean {
  return compareTmuxVersions(version, MINIMUM_TMUX_VERSION) >= 0;
}
