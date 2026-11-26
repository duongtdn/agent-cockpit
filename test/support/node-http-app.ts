import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Cockpit } from '../../src/server/index.ts';
import { baseUrlOf } from './wire-client.ts';

/**
 * An app on a plain `node:http` server, the cockpit mounted under a prefix
 * as the guide shows. It listens before the cockpit exists: with the
 * neutral handler the app gives the cockpit its port, so it must know it
 * first.
 */
export interface NodeHttpApp {
  /** The port it listens on. */
  readonly port: number;
  /** The mount's base URL, `http://<address>:<port><prefix>`. */
  readonly base: string;
  /** Mounts the cockpit: until then, a request under the prefix is answered 503. */
  serve(cockpit: Pick<Cockpit, 'handle' | 'upgrade'>): void;
  /** Ends every connection and stops listening. */
  close(): Promise<void>;
}

/**
 * Starts a `node:http` app listening on an address of the machine, on a
 * port the system chooses.
 *
 * @param address - The address it listens on.
 * @param prefix - The prefix the cockpit is mounted under.
 */
export async function startNodeHttpApp(address: string, prefix = '/cockpit'): Promise<NodeHttpApp> {
  let cockpit: Pick<Cockpit, 'handle' | 'upgrade'> | undefined;
  const under = (request: IncomingMessage): boolean => {
    const url = request.url ?? '/';
    const rest = url.slice(prefix.length);
    if (!url.startsWith(prefix) || !(rest === '' || rest.startsWith('/') || rest.startsWith('?'))) {
      return false;
    }
    request.url = rest.startsWith('/') ? rest : `/${rest}`;
    return true;
  };
  const server: Server = createServer((request, response) => {
    if (!under(request)) return void response.writeHead(404).end('the app’s own');
    if (cockpit === undefined) return void response.writeHead(503).end();
    cockpit.handle(request, response);
  });
  server.on('upgrade', (request, socket, head) => {
    if (!under(request) || cockpit === undefined) return void socket.destroy();
    cockpit.upgrade(request, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, address, resolve));
  const listening = server.address() as AddressInfo;
  return {
    port: listening.port,
    base: `${baseUrlOf(listening)}${prefix}`,
    serve(mounted) {
      cockpit = mounted;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
