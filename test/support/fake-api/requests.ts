/** A message of a request's conversation. */
export type RequestMessage = {
  readonly role: string;
  readonly content: string | readonly Readonly<Record<string, unknown>>[];
};

/**
 * The JSON body of a request to the Messages API, as far as a test reads it.
 * It is what the client sent, parsed and not validated.
 */
export type MessagesRequestBody = {
  readonly model?: string;
  readonly stream?: boolean;
  readonly max_tokens?: number;
  readonly system?: unknown;
  readonly messages?: readonly RequestMessage[];
  readonly tools?: readonly { readonly name?: string }[];
  readonly [field: string]: unknown;
};

/**
 * What a request is to the double: a turn of the conversation, which takes
 * the next scripted answer; a side request or a token count, which get a
 * harmless answer; or a path the double does not know.
 */
export type RequestKind = 'conversation' | 'side' | 'count-tokens' | 'unknown';

/**
 * A request as the double logs it. It never holds a header: a key the
 * client sends must not reach a log or a failure message.
 */
export type LoggedRequest = {
  /** Its number among all the requests of the double, counting from 1. */
  readonly number: number;
  readonly kind: RequestKind;
  readonly method: string;
  /** The path as sent, with its query. */
  readonly path: string;
  /** The parsed JSON body; `undefined` when there is none or it is not a JSON object. */
  readonly body: MessagesRequestBody | undefined;
};

/** Tells the side requests among the requests to `/v1/messages`. */
export type SideRequestRule = (body: MessagesRequestBody) => boolean;

/**
 * The default rule for side requests: a request that offers no tools. The
 * agent's turns, its sub-agents' included, always offer its tools; the short
 * calls it makes on the side (a title, a quota check) offer none.
 *
 * @param body - The request's body.
 * @returns Whether the request is a side request.
 */
export const offersNoTools: SideRequestRule = (body) =>
  !Array.isArray(body.tools) || body.tools.length === 0;

/**
 * Says what a request is to the double.
 *
 * @param method - The HTTP method.
 * @param path - The path as sent; its query does not count.
 * @param body - The parsed body, if any.
 * @param isSideRequest - The rule for side requests.
 * @returns The request's kind.
 */
export function requestKind(
  method: string,
  path: string,
  body: MessagesRequestBody | undefined,
  isSideRequest: SideRequestRule,
): RequestKind {
  const { pathname } = new URL(path, 'http://fake-api.invalid');
  if (method !== 'POST') return 'unknown';
  if (pathname === '/v1/messages/count_tokens') return 'count-tokens';
  if (pathname !== '/v1/messages') return 'unknown';
  return isSideRequest(body ?? {}) ? 'side' : 'conversation';
}

/**
 * Parses a request's body.
 *
 * @param text - The body as received.
 * @returns The JSON object it holds, or `undefined` when it holds none.
 */
export function parseBody(text: string): MessagesRequestBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as MessagesRequestBody)
      : undefined;
  } catch {
    return undefined;
  }
}
