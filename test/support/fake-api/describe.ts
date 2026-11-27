import type { LoggedRequest, RequestMessage } from './requests.ts';
import type { ScriptedAnswer, Turn, TurnBlock } from './script.ts';

/** Enough of a text to recognize it in a failure message. */
const EXCERPT_LENGTH = 80;

/**
 * Names a conversation request in a failure message: its numbers, its
 * method, path and model, and what the user last said. Never a header.
 *
 * @param request - The logged request.
 * @param conversationNumber - Its number among the conversation requests.
 * @returns One line naming it.
 */
export function describeConversationRequest(
  request: LoggedRequest,
  conversationNumber: number,
): string {
  const model = request.body?.model ?? 'unknown';
  return (
    `conversation request ${conversationNumber} (request ${request.number}, ` +
    `${request.method} ${request.path}, model ${model}), ` +
    `last user message: ${lastUserMessage(request.body?.messages ?? [])}`
  );
}

/**
 * Names a scripted answer in a failure message.
 *
 * @param answer - The scripted answer.
 * @returns One line naming it.
 */
export function describeAnswer(answer: ScriptedAnswer): string {
  switch (answer.kind) {
    case 'turn':
      return describeTurn(answer);
    case 'error':
      return `error ${answer.status} ${answer.errorType}`;
    case 'cut':
      return `cut after ${answer.afterEvents} events of ${describeTurn(answer.turn)}`;
    case 'held':
      return `held ${describeTurn(answer.turn)}`;
    case 'streaming':
      return `streaming ${describeTurn(answer.turn)}`;
  }
}

function describeTurn(turn: Turn): string {
  return `turn(${turn.blocks.map(describeBlock).join(', ')})`;
}

function describeBlock(block: TurnBlock): string {
  return block.type === 'text' ? `text ${quoted(block.text)}` : `tool_use ${block.name}`;
}

function lastUserMessage(messages: readonly RequestMessage[]): string {
  const last = messages.findLast((message) => message.role === 'user');
  if (last === undefined) return 'none';
  if (typeof last.content === 'string') return quoted(last.content);
  if (last.content.some((block) => block.type === 'tool_result')) return 'a tool result';
  return quoted(
    last.content
      .map((block) => block.text)
      .filter((text) => typeof text === 'string')
      .join(' '),
  );
}

function quoted(text: string): string {
  return JSON.stringify(text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text);
}
