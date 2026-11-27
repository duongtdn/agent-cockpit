import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { Arrivals } from './arrivals.ts';
import { describeAnswer, describeConversationRequest } from './describe.ts';
import { type Message, messageEvents, turnMessage } from './message.ts';
import {
  type LoggedRequest,
  offersNoTools,
  parseBody,
  type RequestMessage,
  requestKind,
  type SideRequestRule,
} from './requests.ts';
import {
  type CutStream,
  type HeldTurn,
  type ScriptedAnswer,
  type StreamingTurn,
  type Turn,
  turn,
} from './script.ts';
import { type StreamEvent, sseFrame } from './sse.ts';

/** The options of {@link startFakeApi}. */
export type FakeApiOptions = {
  /**
   * Tells which requests to `/v1/messages` are side requests: they get a
   * short text answer and take no scripted answer. By default, the requests
   * that offer no tools.
   */
  readonly isSideRequest?: SideRequestRule;
  /**
   * The turn a conversation request gets when the script holds no answer
   * left: a demo's one answer to whatever is asked, so that a person may run
   * as many sessions as they like. Without it, such a request is refused
   * and counts as unexpected.
   */
  readonly fallback?: Turn;
};

/** How a held turn ended: the test released it, or the connection closed first. */
export type HoldOutcome = 'released' | 'client-gone';

/** A conversation request whose answer has started and waits. */
export type HeldRequest = {
  /** The request being held. */
  readonly request: LoggedRequest;
  /** Sends the rest of the turn; does nothing once the client has gone away. */
  release(): void;
  /** Resolves when the hold is over, with how it ended. */
  readonly ended: Promise<HoldOutcome>;
};

/** A running double of the Messages API. */
export type FakeApi = {
  /** Where the double listens, for `ANTHROPIC_BASE_URL`: `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /**
   * Adds answers to the script: each conversation request takes the next one.
   *
   * @param answers - Turns, API errors, cut streams and held turns, in order.
   */
  script(...answers: readonly ScriptedAnswer[]): void;
  /**
   * Adds answers to the script of another conversation than the session's
   * own: a subagent's, which the agent runs beside it. Its requests are told
   * by their first message, which holds the subagent's prompt; each takes
   * the next answer scripted for it, never one of {@link FakeApi.script}'s,
   * whatever the order the two conversations' requests arrive in.
   *
   * @param prompt - The text the conversation's first message holds: the prompt the subagent was given.
   * @param answers - Its answers, in order.
   */
  scriptConversation(prompt: string, ...answers: readonly ScriptedAnswer[]): void;
  /**
   * Gives every request received so far, in order, without any header.
   *
   * @returns The log.
   */
  requests(): readonly LoggedRequest[];
  /**
   * Gives the requests to paths the double does not know, each answered
   * with a 404: for a test to tell the ones it expects from the others.
   *
   * @returns The requests, in order.
   */
  unknownRequests(): readonly LoggedRequest[];
  /**
   * Awaits a conversation request, to read what the agent sent.
   *
   * @param number - Which one, counting from 1 among the conversation requests.
   * @returns The request, once it has arrived.
   */
  conversationRequest(number: number): Promise<LoggedRequest>;
  /**
   * Awaits a request being held by a scripted held turn.
   *
   * @param number - Which one, counting from 1 among the held requests; the first by default.
   * @returns The held request, once its answer has started.
   */
  heldRequest(number?: number): Promise<HeldRequest>;
  /**
   * The final check of a test.
   *
   * @throws Error when a conversation request arrived with no answer scripted, naming each.
   */
  assertNothingUnexpected(): void;
  /**
   * Awaits the first conversation request with no answer scripted, for a
   * wait to end on it instead of on its timeout.
   *
   * @returns The error of {@link FakeApi.assertNothingUnexpected}, once such
   *   a request has arrived; it stays pending for as long as none has.
   */
  unexpectedRequest(): Promise<Error>;
  /**
   * Checks that the conversation went as far as the script.
   *
   * @throws Error when scripted answers were never asked for, naming each.
   */
  assertScriptUsedUp(): void;
  /**
   * Stops the double: destroys the connections still open, held streams
   * included, and frees the port. Safe to call twice.
   */
  close(): Promise<void>;
};

/** One request being answered. */
type Exchange = {
  readonly request: LoggedRequest;
  readonly response: ServerResponse;
};

const SIDE_ANSWER = turn('ok');
const COUNTED_TOKENS = { input_tokens: 10 };
/** What a message names when the request named no model. */
const UNNAMED_MODEL = 'fake-model';
/**
 * What an unscripted request is answered with. The agent asks once more
 * after most errors, a 400 among them (six times); a 403 it takes as final,
 * and it keeps the error's message on its screen.
 */
const UNSCRIPTED_ERROR = { status: 403, errorType: 'permission_error' };

/**
 * Starts a double of Anthropic's Messages API on a loopback port of its own.
 *
 * @param options - See {@link FakeApiOptions}.
 * @returns The running double; the caller closes it.
 */
export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const isSideRequest = options.isSideRequest ?? offersNoTools;
  const script: ScriptedAnswer[] = [];
  const otherConversations = new Map<string, ScriptedAnswer[]>();
  const log: LoggedRequest[] = [];
  const conversationRequests = new Arrivals<LoggedRequest>();
  const heldRequests = new Arrivals<HeldRequest>();
  const unscripted: string[] = [];
  let tellOfUnscripted: (error: Error) => void = () => {};
  const firstUnscripted = new Promise<Error>((resolve) => {
    tellOfUnscripted = resolve;
  });
  let conversationCount = 0;
  let messageCount = 0;
  let closed: Promise<void> | undefined;

  async function logged(incoming: IncomingMessage): Promise<LoggedRequest> {
    const body = parseBody(await text(incoming));
    const method = incoming.method ?? '';
    const path = incoming.url ?? '/';
    const request: LoggedRequest = {
      number: log.length + 1,
      kind: requestKind(method, path, body, isSideRequest),
      method,
      path,
      body,
    };
    log.push(request);
    return request;
  }

  function answer(exchange: Exchange): void {
    switch (exchange.request.kind) {
      case 'unknown':
        sendError(exchange.response, 404, {
          errorType: 'not_found_error',
          message: `Fake API: nothing at ${exchange.request.method} ${exchange.request.path}`,
        });
        break;
      case 'count-tokens':
        sendJson(exchange.response, 200, COUNTED_TOKENS);
        break;
      case 'side':
        sendMessage(exchange, messageFor(exchange, SIDE_ANSWER));
        break;
      case 'conversation':
        conversationCount += 1;
        conversationRequests.add(exchange.request);
        answerFromScript(exchange, scriptOf(exchange.request).shift() ?? options.fallback);
        break;
    }
  }

  function answerFromScript(exchange: Exchange, scripted: ScriptedAnswer | undefined): void {
    switch (scripted?.kind) {
      case undefined:
        refuseUnscripted(exchange);
        break;
      case 'turn':
        sendMessage(exchange, messageFor(exchange, scripted));
        break;
      case 'error':
        sendError(exchange.response, scripted.status, scripted);
        break;
      case 'cut':
        cut(exchange, scripted);
        break;
      case 'held':
        hold(exchange, scripted);
        break;
      case 'streaming':
        streamUntilReleased(exchange, scripted);
        break;
    }
  }

  /** The script a request answers from: its conversation's, when one was scripted apart. */
  function scriptOf(request: LoggedRequest): ScriptedAnswer[] {
    const opening = textsOf(request.body?.messages?.[0]);
    const prompt = [...otherConversations.keys()].find((text) => opening.includes(text));
    return prompt === undefined ? script : (otherConversations.get(prompt) as ScriptedAnswer[]);
  }

  function refuseUnscripted(exchange: Exchange): void {
    const description = describeConversationRequest(exchange.request, conversationCount);
    unscripted.push(description);
    tellOfUnscripted(unscriptedError(unscripted));
    sendError(exchange.response, UNSCRIPTED_ERROR.status, {
      errorType: UNSCRIPTED_ERROR.errorType,
      message: `Fake API: no answer scripted for ${description}`,
    });
  }

  function messageFor(exchange: Exchange, scripted: Turn): Message {
    messageCount += 1;
    return turnMessage(scripted, {
      model: exchange.request.body?.model ?? UNNAMED_MODEL,
      sequence: messageCount,
    });
  }

  function cut(exchange: Exchange, scripted: CutStream): void {
    const { response } = exchange;
    if (!asksForStream(exchange)) {
      response.destroy();
      return;
    }
    const sent = messageEvents(messageFor(exchange, scripted.turn)).slice(0, scripted.afterEvents);
    startStream(response);
    // Destroyed only once the part is written, or the client might never see it.
    response.write(frames(sent), () => response.destroy());
  }

  function hold(exchange: Exchange, scripted: HeldTurn): void {
    const { request, response } = exchange;
    const message = messageFor(exchange, scripted.turn);
    const events = messageEvents(message);
    const sent = events.slice(0, scripted.afterEvents);
    const rest = events.slice(scripted.afterEvents);
    const streamed = asksForStream(exchange);
    if (streamed) {
      startStream(response);
      response.write(frames(sent));
    }
    let released = false;
    const ended = new Promise<HoldOutcome>((resolve) => {
      // An answer released closes too, once sent: the hold is over either way.
      response.once('close', () => resolve(released ? 'released' : 'client-gone'));
    });
    const release = () => {
      if (released || response.destroyed) return;
      released = true;
      if (streamed) response.end(frames(rest));
      else sendJson(response, 200, message);
    };
    heldRequests.add({ request, release, ended });
  }

  function streamUntilReleased(exchange: Exchange, scripted: StreamingTurn): void {
    const { request, response } = exchange;
    const message = messageFor(exchange, scripted.turn);
    if (!asksForStream(exchange)) {
      hold(exchange, { kind: 'held', turn: scripted.turn, afterEvents: 0 });
      return;
    }
    // The first text's events: the message's start, the block's start, its one delta.
    const [start, blockStart, textDelta, ...rest] = messageEvents(message) as [
      StreamEvent,
      StreamEvent,
      StreamEvent,
      ...StreamEvent[],
    ];
    const text = (textDelta.delta as { text: string }).text;
    const piece = (from: number, to: number): StreamEvent => ({
      ...textDelta,
      delta: { type: 'text_delta', text: text.slice(from, to) },
    });
    startStream(response);
    response.write(frames([start, blockStart]));
    let sent = 0;
    const pieces = setInterval(() => {
      if (sent >= text.length) return clearInterval(pieces);
      response.write(frames([piece(sent, sent + scripted.pieceLength)]));
      sent += scripted.pieceLength;
    }, scripted.gapMs);
    let released = false;
    const ended = new Promise<HoldOutcome>((resolve) => {
      response.once('close', () => {
        clearInterval(pieces);
        resolve(released ? 'released' : 'client-gone');
      });
    });
    const release = () => {
      if (released || response.destroyed) return;
      released = true;
      clearInterval(pieces);
      const left = sent < text.length ? [piece(sent, text.length)] : [];
      response.end(frames([...left, ...rest]));
    };
    heldRequests.add({ request, release, ended });
  }

  const server = createServer((incoming, response) => {
    logged(incoming).then(
      (request) => answer({ request, response }),
      // The client went away while sending: there is no one to answer.
      () => response.destroy(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    script: (...answers) => {
      script.push(...answers);
    },
    scriptConversation: (prompt, ...answers) => {
      otherConversations.set(prompt, [...(otherConversations.get(prompt) ?? []), ...answers]);
    },
    requests: () => [...log],
    unknownRequests: () => log.filter((request) => request.kind === 'unknown'),
    conversationRequest: (number) => conversationRequests.nth(number),
    heldRequest: (number = 1) => heldRequests.nth(number),
    assertNothingUnexpected: () => {
      if (unscripted.length > 0) throw unscriptedError(unscripted);
    },
    unexpectedRequest: () => firstUnscripted,
    assertScriptUsedUp: () => {
      const unused = [script, ...otherConversations.values()].flat().map(describeAnswer);
      if (unused.length > 0) throw listed('Scripted answers never asked for', unused);
    },
    close: () => {
      closed ??= new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}

/** Every text of a message, its blocks' joined: what a test can name a conversation by. */
function textsOf(message: RequestMessage | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function asksForStream(exchange: Exchange): boolean {
  return exchange.request.body?.stream === true;
}

function sendMessage(exchange: Exchange, message: Message): void {
  if (asksForStream(exchange)) {
    startStream(exchange.response);
    exchange.response.end(frames(messageEvents(message)));
  } else {
    sendJson(exchange.response, 200, message);
  }
}

function startStream(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

function frames(events: readonly StreamEvent[]): string {
  return events.map(sseFrame).join('');
}

function sendError(
  response: ServerResponse,
  status: number,
  error: { readonly errorType: string; readonly message: string },
): void {
  sendJson(response, status, {
    type: 'error',
    error: { type: error.errorType, message: error.message },
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function unscriptedError(requests: readonly string[]): Error {
  return listed('Conversation requests with no scripted answer', requests);
}

function listed(heading: string, lines: readonly string[]): Error {
  return new Error(`${heading} (${lines.length}):\n${lines.map((line) => `  ${line}`).join('\n')}`);
}
