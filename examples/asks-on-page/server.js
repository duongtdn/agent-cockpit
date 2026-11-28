// Asks on the page: an app on Fastify that mounts the cockpit under
// `/cockpit`, offers jobs whose agent asks a permission (`jobs.js`), serves
// the page that shows and answers the agent's asks, with no terminal
// mounted, and prints the link to open and how to reach a session's
// terminal.
//
//   node examples/asks-on-page/server.js            the scripted agent (no model, no login)
//   node examples/asks-on-page/server.js --real     your own `claude` and its login
//   --port <n>                                       the page's port (4330; 0 for any free one)
//
// See DEMO.md. It imports the package by its name, as an app does: run
// `pnpm build` first.

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCockpit } from '@duongtdn/agent-cockpit';
import { claudeCode } from '@duongtdn/agent-cockpit/claude-code';
import { cockpitFastify } from '@duongtdn/agent-cockpit/fastify';
import Fastify from 'fastify';
import { jobsOf } from './jobs.js';

/** The app's name: its tmux socket (`agent-cockpit-asks-on-page`), its state folder, its lock. */
const APP_NAME = 'asks-on-page';

/** The tmux socket the cockpit runs the app's sessions on. */
const TMUX_SOCKET = `agent-cockpit-${APP_NAME}`;

const here = dirname(fileURLToPath(import.meta.url));

/** The page's own files, beside `index.html`: its style sheet and its modules. */
const PAGE_FILES = ['page.css', 'page.js', 'asks-list.js', 'sessions-table.js', 'explain.js'];

const { values: options } = parseArgs({
  options: {
    real: { type: 'boolean', default: false },
    port: { type: 'string', default: '4330' },
  },
});

// Ctrl+C, a `kill`, or the terminal closing — at any time, while it starts
// too: the stop waits for what is starting, then stops all that started. A
// second signal while stopping changes nothing: the first one's stop goes on.
let stopping;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopping ??= starting
      .catch(() => {})
      .then(stop)
      .then(
        () => console.log('Stopped.'),
        (error) => {
          console.error(error);
          // What failed to stop may hold the process open.
          process.exit(1);
        },
      );
  });
}

let agent;
let cockpit;
let app;
const starting = start();
try {
  await starting;
} catch (error) {
  if (stopping === undefined) {
    // What started before the failure is stopped; the failure is what is told.
    await stop().catch(() => {});
    throw error;
  }
  // Stopped while it started: the stop under way removes what started.
  console.error(error);
  process.exitCode = 1;
}
if (stopping === undefined) {
  console.log(`A session's terminal: ${agent.tmux} attach -t <key>`);
  console.log(`Open ${cockpit.link(`http://127.0.0.1:${app.server.address().port}/`)}`);
}

async function start() {
  // The default is a stand-in for the agent's model, so that the example runs
  // with no login and costs nothing. It is the example's, not the package's.
  agent = options.real ? yourOwnAgent() : await scriptedAgent();
  console.log(agent.description);
  cockpit = await createCockpit({
    name: APP_NAME,
    directory: agent.directory,
    driver: agent.driver(claudeCode()),
    jobs: jobsOf(),
    ...(agent.stateDirectory === undefined ? {} : { stateDirectory: agent.stateDirectory }),
  });
  app = Fastify();
  await app.register(cockpitFastify(cockpit), { prefix: '/cockpit' });
  for (const [path, file] of pageFiles()) {
    app.get(path, async (_request, reply) =>
      reply.type(CONTENT_TYPES[extname(file)]).send(await readFile(file)),
    );
  }
  await app.listen({ host: '127.0.0.1', port: Number(options.port) });
}

/**
 * Stops in order: the cockpit first (it closes the page's WebSockets, which
 * would hold the server open), then the server, then what the agent's mode
 * started. Each step is tried, whatever the one before did. The sessions of
 * your own agent go on in tmux; the scripted ones end with their stand-in.
 */
async function stop() {
  try {
    await cockpit?.close();
  } finally {
    try {
      await app?.close();
    } finally {
      await agent?.close();
    }
  }
}

function yourOwnAgent() {
  return {
    description: `Your own agent: \`claude\` from your PATH, with your login, in ${process.cwd()}.`,
    directory: process.cwd(),
    tmux: `tmux -L ${TMUX_SOCKET}`,
    driver: (driver) => driver,
    close: async () => {},
  };
}

async function scriptedAgent() {
  // Loaded only in this mode: it is the repository's test support, run from its development install.
  const { startScriptedAgent } = await import('../../test/support/scripted-agent.ts');
  const scripted = await startScriptedAgent(APP_NAME);
  return {
    description: `The scripted agent: the pinned Claude Code against a fake API, in ${scripted.root}.`,
    directory: scripted.workFolder,
    stateDirectory: scripted.stateFolder,
    // The scripted agent keeps the cockpit's tmux socket in its own folder.
    tmux: `TMUX_TMPDIR=${process.env.TMUX_TMPDIR} tmux -L ${TMUX_SOCKET}`,
    driver: (driver) => scripted.driver(driver),
    close: () => scripted.close(),
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

/**
 * The files the page loads, by the path it asks for: the page itself, and
 * the browser modules it imports through its import map — the package's
 * `client` entry (and the `shared` modules it imports) as the package built
 * them. No terminal is mounted, so neither the `terminal` entry nor
 * xterm.js is served. Nothing else is: no bundler, no folder served as a
 * whole.
 */
function pageFiles() {
  const cockpitBuild = dirname(
    dirname(fileURLToPath(import.meta.resolve('@duongtdn/agent-cockpit/client'))),
  );
  const cockpitModules = ['client', 'shared'].flatMap((folder) =>
    readdirSync(join(cockpitBuild, folder))
      .filter((file) => file.endsWith('.js'))
      .map((file) => [
        `/modules/agent-cockpit/${folder}/${file}`,
        join(cockpitBuild, folder, file),
      ]),
  );
  return new Map([
    ['/', join(here, 'page', 'index.html')],
    ...PAGE_FILES.map((file) => [`/${file}`, join(here, 'page', file)]),
    ...cockpitModules,
  ]);
}
