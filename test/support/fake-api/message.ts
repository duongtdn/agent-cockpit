import type { Turn, TurnBlock, Usage } from './script.ts';
import type { StreamEvent } from './sse.ts';

/** A content block of a message, as the Messages API returns it. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    };

/** A message of the assistant, as the Messages API returns it when it does not stream. */
export type Message = {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly model: string;
  readonly content: readonly ContentBlock[];
  readonly stop_reason: 'end_turn' | 'tool_use';
  readonly stop_sequence: null;
  readonly usage: Usage;
};

/** What tells one message of a double from the others. */
export type MessageIdentity = {
  /** The model the request asked for, which the answer names. */
  readonly model: string;
  /** The message's number among the double's answers; its ids come from it. */
  readonly sequence: number;
};

/** What the stream's first event counts, before the model has written anything more. */
const OUTPUT_TOKENS_AT_START = 1;

/**
 * Builds the message a scripted turn answers with.
 *
 * @param turn - The scripted turn.
 * @param identity - The model to name and the message's number; the ids of
 *   the message and of its tool calls follow from the number, so that no two
 *   messages of a double share one.
 * @returns The message, as a request without `stream` gets it.
 */
export function turnMessage(turn: Turn, identity: MessageIdentity): Message {
  const content = turn.blocks.map((block, index) => contentBlock(block, identity.sequence, index));
  return {
    id: `msg_fake_${identity.sequence}`,
    type: 'message',
    role: 'assistant',
    model: identity.model,
    content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: turn.usage,
  };
}

/**
 * Lays a message out as the events of the Messages API's stream: its start,
 * each block (start, one delta, stop), the stop reason with the usage, its end.
 *
 * @param message - The message to stream.
 * @returns The events, in the order they are sent.
 */
export function messageEvents(message: Message): StreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: OUTPUT_TOKENS_AT_START },
      },
    },
    ...message.content.flatMap(blockEvents),
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    },
    { type: 'message_stop' },
  ];
}

function contentBlock(block: TurnBlock, sequence: number, index: number): ContentBlock {
  return block.type === 'text' ? block : { ...block, id: `toolu_fake_${sequence}_${index}` };
}

function blockEvents(block: ContentBlock, index: number): StreamEvent[] {
  // A block starts empty and its delta carries all of it, as the API does
  // for a block short enough to fit one delta.
  const [emptyBlock, delta] =
    block.type === 'text'
      ? [
          { ...block, text: '' },
          { type: 'text_delta', text: block.text },
        ]
      : [
          { ...block, input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        ];
  return [
    { type: 'content_block_start', index, content_block: emptyBlock },
    { type: 'content_block_delta', index, delta },
    { type: 'content_block_stop', index },
  ];
}
