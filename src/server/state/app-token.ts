import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateFile } from './private-files.js';
import { mintToken, tokensMatch } from './tokens.js';

/** The file of the state folder that holds the app's token. */
const APP_TOKEN_FILE = 'app-token';

/** What a token the cockpit minted looks like: 256 bits in base64url, unpadded. */
const MINTED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The app's token: what a browser proves itself with. */
export interface AppToken {
  /** The token, for the link the app gives the person. */
  readonly value: string;
  /**
   * Tells whether a request's token is the app's, in constant time.
   *
   * @param candidate - The token the request carried; `undefined` for none.
   */
  matches(candidate: string | undefined): boolean;
}

/**
 * Opens the app's token: the one kept in the state folder, so that a
 * restart sends no browser back for the link, or a new one at the first
 * start — or when the file holds no token the cockpit could have minted.
 * Called with the app's lock held, so no other process writes it meanwhile.
 *
 * @param folder - The app's state folder.
 * @returns The token.
 */
export async function openAppToken(folder: string): Promise<AppToken> {
  const file = join(folder, APP_TOKEN_FILE);
  const kept = await readKept(file);
  const value = kept ?? mintToken();
  if (kept === undefined) await writePrivateFile(file, value);
  return { value, matches: (candidate) => tokensMatch(value, candidate) };
}

async function readKept(file: string): Promise<string | undefined> {
  try {
    const content = await readFile(file, 'utf8');
    return MINTED_TOKEN.test(content) ? content : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
