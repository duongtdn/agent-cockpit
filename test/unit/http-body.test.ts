import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readBodyWithin } from '../../src/server/http/body.ts';

/** A request whose body arrives in the chunks given, as a socket may cut it. */
function requestOf(chunks: readonly Buffer[]): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage;
}

describe('reading a request body', () => {
  it('decodes the body whole: a character cut between two chunks arrives intact', () => {
    // A hook's payload carries the prompt: past 64 KiB, the socket's chunks cut its characters.
    const text = `{"prompt":"${'Tiếng Việt 日本語 😀'.repeat(5000)}"}`;
    const bytes = Buffer.from(text);
    // At a continuation byte past 64 KiB: inside a character.
    const cut = bytes.findIndex((byte, index) => index >= 65_536 && (byte & 0xc0) === 0x80);
    expect(bytes.subarray(0, cut).toString('utf8')).toContain('�');

    return expect(
      readBodyWithin(requestOf([bytes.subarray(0, cut), bytes.subarray(cut)]), 1024 * 1024),
    ).resolves.toBe(text);
  });

  it('drops a body over the limit', () => {
    return expect(readBodyWithin(requestOf([Buffer.alloc(10)]), 9)).resolves.toBeUndefined();
  });
});
