import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);

/**
 * A page that mounts a session's terminal, as an app's page would, served to
 * a real browser from the cockpit's own source: the browser modules have
 * their types stripped (Node's own stripping: no bundler), xterm.js comes
 * from the package's ESM build through an import map, and its style sheet
 * is linked. The page reads `baseUrl` and `key` from its query and keeps, on
 * `window`, the mounted terminal (`terminal`) and every status it gave
 * (`statuses`).
 */
export interface TerminalPage {
  /** The page's address for a mount; the fragment carries the app's token. */
  url(options: { baseUrl: string; key: string; token: string }): string;
  /** Stops serving. */
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css" />
    <style>
      body { margin: 0; }
      #terminal { width: 800px; height: 400px; }
    </style>
    <script type="importmap">
      {
        "imports": {
          "@xterm/xterm": "/node_modules/@xterm/xterm/lib/xterm.mjs",
          "@xterm/addon-fit": "/node_modules/@xterm/addon-fit/lib/addon-fit.mjs"
        }
      }
    </script>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      import { mountTerminal } from '/src/terminal/index.js';
      const query = new URLSearchParams(location.search);
      window.statuses = [];
      window.terminal = mountTerminal(document.getElementById('terminal'), query.get('key'), {
        baseUrl: query.get('baseUrl'),
      });
      window.terminal.on('status', (status) => window.statuses.push(status));
    </script>
  </body>
</html>`;

/** The files the page may load: the source's browser folders and xterm.js's builds. */
const SERVED =
  /^\/(src\/(terminal|client|shared)\/[a-z-]+\.js|node_modules\/@xterm\/[a-z-]+\/(lib\/[a-z-]+\.mjs|css\/xterm\.css))$/;

/** Starts serving a {@link TerminalPage} on a free loopback port. */
export async function startTerminalPage(): Promise<TerminalPage> {
  const server = createServer((request, response) => {
    void serve(new URL(request.url ?? '/', 'http://page').pathname, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: ({ baseUrl, key, token }) =>
      `http://127.0.0.1:${port}/?${new URLSearchParams({ baseUrl, key })}#cockpit=${token}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

async function serve(path: string, response: ServerResponse): Promise<void> {
  if (path === '/') {
    send(response, 'text/html', PAGE);
    return;
  }
  if (!SERVED.test(path)) {
    response.writeHead(404).end();
    return;
  }
  if (path.startsWith('/src/')) {
    const source = await readFile(
      fileURLToPath(new URL(`.${path.replace(/\.js$/, '.ts')}`, root)),
      'utf8',
    );
    send(response, 'text/javascript', stripTypeScriptTypes(source));
    return;
  }
  const file = await readFile(fileURLToPath(new URL(`.${path}`, root)));
  send(response, path.endsWith('.css') ? 'text/css' : 'text/javascript', file);
}

function send(response: ServerResponse, contentType: string, body: string | Buffer): void {
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}
