import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** The bits of every token the cockpit mints: too many to guess. */
const TOKEN_BYTES = 32;

/**
 * Mints a token: 256 random bits, in base64url without padding, so that a
 * header and a WebSocket subprotocol carry it as it is.
 *
 * @returns The token, 43 characters.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Tells whether a candidate is a token, in a time that says nothing of how
 * much of it is right: both are hashed first, so that even their lengths are
 * compared without a shortcut.
 *
 * @param token - The token.
 * @param candidate - What a caller gave; `undefined` when it gave none.
 * @returns `true` when the candidate is the token.
 */
export function tokensMatch(token: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  return timingSafeEqual(digest(token), digest(candidate));
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}
