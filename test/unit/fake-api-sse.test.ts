import { describe, expect, it } from 'vitest';
import { sseFrame } from '../support/fake-api/sse.ts';

describe('a server-sent event frame', () => {
  it('names the event, carries it as one line of JSON, and ends with a blank line', () => {
    const frame = sseFrame({ type: 'content_block_stop', index: 0 });

    expect(frame).toBe(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    );
  });

  it('keeps a line break of the text inside the JSON, so that it cannot end the frame', () => {
    const frame = sseFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'one\n\ntwo' },
    });

    expect(frame.split('\n')).toHaveLength(4);
    expect(JSON.parse(frame.split('\n')[1]?.slice('data: '.length) ?? '')).toMatchObject({
      delta: { text: 'one\n\ntwo' },
    });
  });
});
