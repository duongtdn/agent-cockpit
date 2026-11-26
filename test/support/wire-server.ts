import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { TOKEN_HEADER, tokenOfSubprotocols, WIRE_SUBPROTOCOL } from '../../src/shared/wire.ts';

/** Where the test server mounts the wire, as an app mounts the cockpit. */
const MOUNT = '/cockpit';

/** An HTTP request the server received, below the mount. */
export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  /** The token header, when the request carried one. */
  readonly token: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

/** A WebSocket the server accepted, below the mount. */
export interface AcceptedSocket {
  readonly path: string;
  /** The token the handshake's subprotocols carried. */
  readonly token: string | undefined;
  /** The subprotocols the page offered, as the handshake's header lists them. */
  readonly offered: string;
  /** The server's end of it. */
  readonly socket: WebSocket;
  /**
   * Every message the page sent on it, from the first: a text message as its
   * text, a binary one as its bytes.
   */
  readonly messages: (string | Buffer)[];
}

/** An answer the server gives to a request: a status and a body. */
export interface Answer {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
}

/**
 * A loopback server that plays the cockpit's side of the wire, as scripted
 * by the test: it records what the client sends and answers as told. The
 * wire's own seams (paths, the token header, the subprotocols) are the real
 * ones, so the client is tested against what a browser's `fetch` and
 * `WebSocket` truly put on the network.
 */
export interface WireServer {
  /** The mount's absolute URL: the client's `baseUrl`. */
  readonly baseUrl: string;
  /** The HTTP requests received, in order. */
  readonly requests: ReceivedRequest[];
  /** Sets the answer to every later HTTP request on a path. */
  answer(path: string, answer: Answer): void;
  /**
   * Refuses every later WebSocket handshake with this answer, as the request
   * checks would; `undefined` accepts them again.
   */
  refuseSockets(answer: Answer | undefined): void;
  /** Resolves with the next WebSocket the server accepts. */
  nextSocket(): Promise<AcceptedSocket>;
  /** Ends every connection and stops listening. */
  close(): Promise<void>;
}

/** A JSON answer. */
export function json(status: number, value: unknown): Answer {
  return { status, body: JSON.stringify(value), contentType: 'application/json' };
}

/** Starts a {@link WireServer} on a free loopback port. */
export async function startWireServer(): Promise<WireServer> {
  const requests: ReceivedRequest[] = [];
  const answers = new Map<string, Answer>();
  const accepted: AcceptedSocket[] = [];
  const waiting: ((socket: AcceptedSocket) => void)[] = [];
  let socketRefusal: Answer | undefined;

  const sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => (offered.has(WIRE_SUBPROTOCOL) ? WIRE_SUBPROTOCOL : false),
  });

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = pathBelowMount(request);
    requests.push({
      method: request.method ?? '',
      path,
      token: header(request, TOKEN_HEADER),
      contentType: header(request, 'content-type'),
      body,
    });
    send(response, answers.get(path) ?? json(404, { message: 'Nothing here.' }));
  });

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (socketRefusal !== undefined) {
      refuseUpgrade(socket, socketRefusal);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      const offered = header(request, 'sec-websocket-protocol') ?? '';
      const messages: (string | Buffer)[] = [];
      webSocket.on('message', (data: RawData, isBinary: boolean) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.concat([data].flat() as Buffer[]);
        messages.push(isBinary ? bytes : bytes.toString('utf8'));
      });
      const socketAccepted = {
        path: pathBelowMount(request),
        token: tokenOfSubprotocols(offered),
        offered,
        socket: webSocket,
        messages,
      };
      const waiter = waiting.shift();
      if (waiter === undefined) accepted.push(socketAccepted);
      else waiter(socketAccepted);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}${MOUNT}`,
    requests,
    answer: (path, answer) => answers.set(path, answer),
    refuseSockets: (answer) => {
      socketRefusal = answer;
    },
    nextSocket: () => {
      const socket = accepted.shift();
      return socket === undefined
        ? new Promise((resolve) => waiting.push(resolve))
        : Promise.resolve(socket);
    },
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

function pathBelowMount(request: IncomingMessage): string {
  const path = new URL(request.url ?? '/', 'http://server').pathname;
  return path.startsWith(MOUNT) ? path.slice(MOUNT.length) : path;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, { status, body, contentType }: Answer): void {
  response.writeHead(status, contentType === undefined ? {} : { 'content-type': contentType });
  response.end(body);
}

function refuseUpgrade(socket: Socket, { status, body }: Answer): void {
  socket.end(
    `HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
