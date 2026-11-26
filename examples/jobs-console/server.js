// The jobs console: an app on Fastify that mounts the cockpit under
// `/cockpit`, offers its jobs (`jobs.js`), serves the page that draws a
// launcher form for each, and prints the link to open.
//
//   node examples/jobs-console/server.js            the scripted agent (no model, no login)
//   node examples/jobs-console/server.js --real     your own `claude` and its login
//   --port <n>                                       the page's port (4310; 0 for any free one)
//   --max-sessions <n>                               the cap on live sessions (none by default)
//
// See DEMO.md. It imports the package by its name, as an app does: run
// `pnpm build` first.

import { readdirSync } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCockpit } from '@duongtdn/agent-cockpit';
import { claudeCode } from '@duongtdn/agent-cockpit/claude-code';
import { cockpitFastify } from '@duongtdn/agent-cockpit/fastify';
import Fastify from 'fastify';
import { jobsOf } from './jobs.js';

/** The app's name: its tmux socket (`agent-cockpit-jobs-console`), its state folder, its lock. */
const APP_NAME = 'jobs-console';

const here = dirname(fileURLToPath(import.meta.url));

/** The page's own files, beside `index.html`: its style sheet and its modules. */
const PAGE_FILES = ['page.css', 'page.js', 'launcher.js', 'sessions-list.js', 'results.js'];

const { values: options } = parseArgs({
  options: {
    real: { type: 'boolean', default: false },
    port: { type: 'string', default: '4310' },
    'max-sessions': { type: 'string' },
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
    jobs: jobsOf(agent.directory),
    ...(options['max-sessions'] === undefined
      ? {}
      : { maxSessions: Number(options['max-sessions']) }),
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
    driver: (driver) => driver,
    close: async () => {},
  };
}

async function scriptedAgent() {
  // Loaded only in this mode: it is the repository's test support, run from its development install.
  const { startScriptedAgent } = await import('../../test/support/scripted-agent.ts');
  const scripted = await startScriptedAgent(APP_NAME);
  // Something to choose in the forms: the sessions work in a copy of the sample project.
  await cp(join(here, 'sample-project'), scripted.workFolder, { recursive: true }).catch(
    async (error) => {
      await scripted.close();
      throw error;
    },
  );
  return {
    description: `The scripted agent: the pinned Claude Code against a fake API, in ${scripted.root}.`,
    directory: scripted.workFolder,
    stateDirectory: scripted.stateFolder,
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
 * `client` and `terminal` entries (and the `shared` modules they import) as
 * the package built them, xterm.js's ESM build and its style sheet. Nothing
 * else is served: no bundler, no folder served as a whole.
 */
function pageFiles() {
  const require = createRequire(import.meta.url);
  const packageOf = (name) => dirname(require.resolve(`${name}/package.json`));
  const cockpitBuild = dirname(
    dirname(fileURLToPath(import.meta.resolve('@duongtdn/agent-cockpit/client'))),
  );
  const cockpitModules = ['client', 'terminal', 'shared'].flatMap((folder) =>
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
    ['/modules/xterm/xterm.mjs', join(packageOf('@xterm/xterm'), 'lib', 'xterm.mjs')],
    ['/modules/xterm/xterm.css', join(packageOf('@xterm/xterm'), 'css', 'xterm.css')],
    [
      '/modules/addon-fit/addon-fit.mjs',
      join(packageOf('@xterm/addon-fit'), 'lib', 'addon-fit.mjs'),
    ],
    ...cockpitModules,
  ]);
}
