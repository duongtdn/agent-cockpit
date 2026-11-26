import { once } from 'node:events';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type RawData, WebSocket } from 'ws';
import { TOKEN_HEADER, wireSubprotocols } from '../../src/shared/wire.ts';

/**
 * A caller of the cockpit's wire as a browser's client is, with what a
 * browser cannot do besides: any header, any source address, the answer
 * to a refused handshake. The checks it meets are the real ones.
 */

/** An HTTP answer: its status, headers and body. */
export interface WireReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** Where a call goes and how it presents itself. */
export interface CallOptions {
  readonly method?: string;
  readonly body?: string;
  /** The app's token, sent in its header; none when left out. */
  readonly token?: string;
  /** Headers beside the token's; `host` replaces the one Node sets. */
  readonly headers?: OutgoingHttpHeaders;
  /** The address the call leaves from. */
  readonly localAddress?: string;
}

/**
 * Calls a URL over HTTP.
 *
 * @param url - The URL, its host an address the server listens on.
 */
export async function call(url: string, options: CallOptions = {}): Promise<WireReply> {
  const sent = httpRequest(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { [TOKEN_HEADER]: options.token }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
  });
  sent.end(options.body);
  const [answer] = await once(sent, 'response');
  let body = '';
  for await (const chunk of answer) body += chunk;
  return { status: answer.statusCode ?? 0, headers: answer.headers, body };
}

/** Calls a URL with a JSON body, as the client's run does. */
export function post(url: string, value: unknown, options: CallOptions = {}): Promise<WireReply> {
  return call(url, { ...options, method: 'POST', body: JSON.stringify(value) });
}

/** A WebSocket of the wire, open, with every message it received. */
export interface OpenSocket {
  readonly socket: WebSocket;
  /** Messages received, in order: text as strings, binary as buffers. */
  readonly messages: (string | Buffer)[];
  /** Resolves with the next message that passes the test, received or to come. */
  next(test: (message: string | Buffer) => boolean): Promise<string | Buffer>;
  /** Resolves with the close code once the socket is closed. */
  readonly closed: Promise<number>;
}

/** What opening a WebSocket gave: the socket, open, or the HTTP answer that refused it. */
export type SocketOutcome =
  | { readonly open: OpenSocket }
  | { readonly refused: WireReply }
  | { readonly destroyed: true };

/**
 * Opens a WebSocket of the wire, the token in the subprotocols as the
 * client sends it.
 *
 * @param url - A `ws:` URL.
 */
export async function openSocket(
  url: string,
  options: Omit<CallOptions, 'method' | 'body'> = {},
): Promise<SocketOutcome> {
  const socket = new WebSocket(
    url,
    options.token === undefined ? ['agent-cockpit'] : wireSubprotocols(options.token),
    {
      ...(options.headers === undefined
        ? {}
        : { headers: options.headers as Record<string, string> }),
      ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
    },
  );
  const messages: (string | Buffer)[] = [];
  const waiting: {
    test: (message: string | Buffer) => boolean;
    resolve(m: string | Buffer): void;
  }[] = [];
  socket.on('message', (data: RawData, isBinary: boolean) => {
    const message = isBinary ? Buffer.from(data as Buffer) : data.toString();
    messages.push(message);
    for (const wait of [...waiting]) {
      if (wait.test(message)) {
        waiting.splice(waiting.indexOf(wait), 1);
        wait.resolve(message);
      }
    }
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  return await new Promise<SocketOutcome>((resolve) => {
    socket.on('open', () =>
      resolve({
        open: {
          socket,
          messages,
          closed,
          next: (test) => {
            const seen = messages.find(test);
            if (seen !== undefined) return Promise.resolve(seen);
            return new Promise((resolveNext) => waiting.push({ test, resolve: resolveNext }));
          },
        },
      }),
    );
    socket.on('unexpected-response', async (_request, answer) => {
      let body = '';
      for await (const chunk of answer) body += chunk;
      resolve({ refused: { status: answer.statusCode ?? 0, headers: answer.headers, body } });
    });
    socket.on('error', () => resolve({ destroyed: true }));
  });
}

/** Opens a WebSocket that must open. */
export async function openedSocket(
  url: string,
  options: Omit<CallOptions, 'method' | 'body'> = {},
): Promise<OpenSocket> {
  const outcome = await openSocket(url, options);
  if (!('open' in outcome)) throw new Error(`The socket did not open: ${JSON.stringify(outcome)}`);
  return outcome.open;
}

/** The base URL of a server listening on an address. */
export function baseUrlOf(address: AddressInfo, protocol = 'http'): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `${protocol}://${host}:${address.port}`;
}
