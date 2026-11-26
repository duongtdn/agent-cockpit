import { join } from 'node:path';
import { inspectOwnFile, type UntrustedStateError } from './own-files.js';
import { writePrivateFile } from './private-files.js';
import { mintToken, tokensMatch } from './tokens.js';

/** The file of the state folder that holds the app's token. */
const APP_TOKEN_FILE = 'app-token';

/** What a token the cockpit minted looks like: 256 bits in base64url, unpadded. */
const MINTED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The app's token: what a browser proves itself with. */
export interface AppToken {
  /** The token in force, for the link the app gives the person. */
  readonly value: string;
  /**
   * Tells whether a request's token is the app's in force, in constant
   * time. It needs no `this`: taken off the token, it still follows every
   * renewal.
   *
   * @param candidate - The token the request carried; `undefined` for none.
   */
  matches(candidate: string | undefined): boolean;
  /**
   * Replaces the token with a new one, as a whole: the new token is written
   * to the state folder (for the app's user alone, never seen half
   * written), then put in force, and the one before is never valid again.
   * Renewals run one after another, so the file always holds the token in
   * force.
   *
   * @returns A promise fulfilled once the new token is in force.
   * @throws The file system's error when the new token cannot be written;
   * the token in force then stays, on disk as in memory.
   */
  renew(): Promise<void>;
}

/**
 * Opens the app's token: the one kept in the state folder, so that a
 * restart sends no browser back for the link, or a new one at the first
 * start — or when the file holds no token the cockpit could have minted, or
 * a group or others had rights on it: the token may then be known, and a
 * new one sends every browser back for the link. Called with the app's lock
 * held, so no other process writes it meanwhile.
 *
 * @param folder - The app's state folder.
 * @returns The token.
 * @throws {@link UntrustedStateError} when the token's file is a symbolic
 * link, no regular file or another user's: who planted it knows the token.
 */
export async function openAppToken(folder: string): Promise<AppToken> {
  const file = join(folder, APP_TOKEN_FILE);
  const kept = await readKept(file);
  let value = kept ?? mintToken();
  if (kept === undefined) await writePrivateFile(file, value);
  let lastRenewal: Promise<void> = Promise.resolve();
  const renewNow = async (): Promise<void> => {
    const next = mintToken();
    // On disk first: a token put in force but not kept would let a restart
    // bring the one before back.
    await writePrivateFile(file, next);
    value = next;
  };
  return {
    get value() {
      return value;
    },
    matches: (candidate) => tokensMatch(value, candidate),
    renew: () => {
      // A renewal that failed leaves the token in force: the next one starts from it.
      lastRenewal = lastRenewal.catch(() => undefined).then(renewNow);
      return lastRenewal;
    },
  };
}

/** The token kept, when it is one the cockpit minted and nobody else could have read. */
async function readKept(file: string): Promise<string | undefined> {
  try {
    const { content, exposed } = await inspectOwnFile(file);
    return !exposed && MINTED_TOKEN.test(content) ? content : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
