import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { APP_PORT_SOURCE, learnsAppPorts } from '../server/app-ports.js';
import type { Cockpit } from '../server/create-cockpit.js';

/**
 * Mounts a cockpit on a Fastify server, under the prefix it is registered
 * with: `app.register(cockpitFastify(cockpit), { prefix: '/cockpit' })`.
 * Wiring only: every request under the prefix goes to `cockpit.handle`, its
 * body unread (Fastify parses none of it), and every WebSocket upgrade
 * under the prefix to `cockpit.upgrade`, the prefix removed from the URL
 * for both. Upgrades elsewhere are left to the app's own upgrade handling;
 * when the app has none, they are ended, as Node ends every upgrade of a
 * server that listens to none. The cockpit learns the ports the server
 * listens on, every address of it, read at each launch, so that every
 * session's sandbox is kept from them; until the server listens, a launch
 * is refused (`no-app-port`), and once Fastify closes the server is
 * forgotten.
 *
 * @param cockpit - The cockpit, as `createCockpit` gave it.
 * @returns The plugin to register.
 */
export function cockpitFastify(cockpit: Cockpit): FastifyPluginAsync {
  return async (fastify) => {
    if (learnsAppPorts(cockpit)) {
      const forget = cockpit[APP_PORT_SOURCE](() => listeningPorts(fastify));
      fastify.addHook('onClose', async () => forget());
    }
    const { prefix } = fastify;
    // The handler reads the body itself: no parser of Fastify's may take it first.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', (_request, _payload, done) => done(null));
    const serve = (request: FastifyRequest, reply: FastifyReply): void => {
      reply.hijack();
      request.raw.url = underPrefix(request.raw.url ?? '', prefix) ?? '/';
      cockpit.handle(request.raw, reply.raw);
    };
    fastify.all('/', serve);
    fastify.all('/*', serve);

    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      const url = underPrefix(request.url ?? '', prefix);
      if (url === undefined) {
        // Node ends an upgrade only when no listener takes it; this listener
        // takes them all, so it ends the stray ones when it is the only one.
        // Another listener — the app's WebSockets — keeps every one it gets.
        if (fastify.server.listenerCount('upgrade') === 1) socket.destroy();
        return;
      }
      request.url = url;
      cockpit.upgrade(request, socket, head);
    };
    fastify.server.on('upgrade', upgrade);
    fastify.addHook('onClose', async () => {
      fastify.server.off('upgrade', upgrade);
    });
  };
}

/** The ports of every address the Fastify server listens on now; none before it listens. */
function listeningPorts(fastify: FastifyInstance): number[] {
  return fastify
    .addresses()
    .flatMap((address) => (typeof address === 'object' ? [address.port] : []));
}

/**
 * The URL below the prefix, as the cockpit's handler takes it; `undefined`
 * for a URL that is not under the prefix.
 */
function underPrefix(url: string, prefix: string): string | undefined {
  if (!url.startsWith(prefix)) return undefined;
  const rest = url.slice(prefix.length);
  if (rest === '' || rest.startsWith('?')) return `/${rest}`;
  return rest.startsWith('/') ? rest : undefined;
}
