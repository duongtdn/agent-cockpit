import type { IncomingHttpHeaders } from 'node:http';

/**
 * Tells whether a request to the agent-facing listener looks like a
 * browser's: it carries an `Origin` header, whatever its value, or a `Host`
 * other than exactly `127.0.0.1:<port>`. The agent's hooks send neither;
 * a page sends `Origin` on every cross-origin request, and a page reaching
 * the listener through a name it rebinds to loopback sends that name as
 * `Host`.
 *
 * @param headers - The request's headers, as Node gives them.
 * @param port - The listener's port.
 * @returns `true` when the request is to be refused.
 */
export function looksLikeBrowser(headers: IncomingHttpHeaders, port: number): boolean {
  return headers.origin !== undefined || headers.host !== `127.0.0.1:${port}`;
}
