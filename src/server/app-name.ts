import { createHash } from 'node:crypto';

/** What a file name keeps of an app's name as it is. */
const PLAIN_IN_FILE_NAME = /[a-z0-9-]/;

/**
 * The most characters of {@link appFileName}. The app's tmux socket is
 * `agent-cockpit-` and this name, at `<TMUX_TMPDIR or /tmp>/tmux-<uid>/`,
 * and the path of a unix socket holds 103 bytes on macOS (107 on Linux).
 * Under `/tmp`, with a user id of ten digits, the folder takes 21 of them:
 * 64 for the socket's name (50 for this one) leave 18 for a longer
 * `TMUX_TMPDIR`.
 */
const APP_FILE_NAME_LENGTH = 50;

/** Hexadecimal digits of the hash that ends the file name of a long app name. */
const HASH_LENGTH = 16;

/**
 * Derives the file name that stands for an app on the machine — its tmux
 * socket's name after `agent-cockpit-`, its state folder's name — from the
 * app's name: its lower-case letters, digits and hyphens kept and every
 * other character written as `_`, its code point in hexadecimal, `_`. A name
 * that would pass 50 characters keeps its beginning, then `.` and 16
 * hexadecimal digits of the SHA-256 of the app's name, 50 characters in all.
 * The result is a plain file name on any file system, never `.` or `..`, and
 * two names never share one — not even two that differ only by case.
 *
 * @param appName - The app's name, any string.
 * @returns The file name, of 50 characters at most.
 */
export function appFileName(appName: string): string {
  const encoded = Array.from(appName, (character) =>
    PLAIN_IN_FILE_NAME.test(character)
      ? character
      : `_${(character.codePointAt(0) ?? 0).toString(16)}_`,
  ).join('');
  if (encoded.length <= APP_FILE_NAME_LENGTH) return encoded;
  const hash = createHash('sha256').update(appName).digest('hex').slice(0, HASH_LENGTH);
  // No other file name holds a ".", so none is taken for a hashed one.
  return `${encoded.slice(0, APP_FILE_NAME_LENGTH - HASH_LENGTH - 1)}.${hash}`;
}
