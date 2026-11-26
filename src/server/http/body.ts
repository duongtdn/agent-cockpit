import type { IncomingMessage } from 'node:http';

/**
 * Reads a request's body whole, as UTF-8 text, up to a limit: a larger body
 * is read to its end and dropped rather than held in memory.
 *
 * @param request - The request.
 * @param maxBytes - The most bytes taken.
 * @returns The text; `undefined` when the body passes the limit.
 */
export async function readBodyWithin(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length <= maxBytes) chunks.push(chunk);
  }
  return length <= maxBytes ? Buffer.concat(chunks).toString('utf8') : undefined;
}
