import type { HookAccess } from '../sessions/sessions.js';
import { mintToken, tokensMatch } from '../state/tokens.js';

/** The sessions' tokens, as the agent-facing listener holds them. */
export interface HookTokens extends HookAccess {
  /**
   * Tells whose a token is, comparing it with every session's in constant
   * time: how a token differs from one that would pass says nothing.
   *
   * @param token - The token a request carried; `undefined` for none.
   * @returns The key of the session it was granted to; `undefined` for a
   * token no live launch holds.
   */
  keyOf(token: string | undefined): string | undefined;
}

/**
 * Creates the sessions' tokens: one per launch, minted when the session is
 * granted access, kept in memory here and written by the driver only in the
 * session's own files — never on a command line or in the environment.
 *
 * @param url - The listener's base URL, which every session reports to.
 * @returns The tokens, none granted.
 */
export function createHookTokens(url: string): HookTokens {
  const tokens = new Map<string, string>();
  return {
    grant(key) {
      const token = mintToken();
      tokens.set(key, token);
      return { url, token };
    },
    revoke(key) {
      tokens.delete(key);
    },
    keyOf(candidate) {
      let found: string | undefined;
      // Every token is compared, the match found or not, so that the time
      // taken tells nothing of which one matched.
      for (const [key, token] of tokens) {
        if (tokensMatch(token, candidate)) found = key;
      }
      return found;
    },
  };
}
