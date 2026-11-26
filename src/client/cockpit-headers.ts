import { TOKEN_HEADER } from '../shared/wire.js';
import { takeTokenFromLink } from './token.js';

/**
 * Gives the headers that carry the app's token, for the app's own requests
 * to routes it guards with `cockpit.verify`:
 * `fetch('/api/whoami', { headers: cockpitHeaders() })`. The token is the
 * page's, as the client keeps it: taken from the link (and the address bar
 * cleared of it) when the page was opened by one, else read from the
 * origin's local storage at each call. A page's navigation carries no
 * header: guard the app's API routes with it, not its pages.
 *
 * @returns `{ 'cockpit-token': token }`; no header when the page has no token.
 */
export function cockpitHeaders(): Record<string, string> {
  const token = takeTokenFromLink().current();
  return token === undefined ? {} : { [TOKEN_HEADER]: token };
}
