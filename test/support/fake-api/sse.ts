/** An event of a stream: `type` names it, the other fields are its own. */
export type StreamEvent = { readonly type: string; readonly [field: string]: unknown };

/**
 * Frames one event the way the Messages API streams it: the event's name,
 * the event as one line of JSON, then the blank line that ends the frame.
 *
 * @param event - The event; its `type` names the frame.
 * @returns The text to write to the stream.
 */
export function sseFrame(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
