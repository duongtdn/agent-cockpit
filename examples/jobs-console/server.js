// The jobs console: an app on Fastify that mounts the cockpit under
// `/cockpit`, offers one job, serves its page, and prints the link to open.
//
//   node examples/jobs-console/server.js            the scripted agent (no model, no login)
//   node examples/jobs-console/server.js --real     your own `claude` and its login
//   --port <n>                                       the page's port (4310; 0 for any free one)
//
// See DEMO.md. It imports the package by its name, as an app does: run
// `pnpm build` first.

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCockpit } from '@duongtdn/agent-cockpit';
import { claudeCode } from '@duongtdn/agent-cockpit/claude-code';
import { cockpitFastify } from '@duongtdn/agent-cockpit/fastify';
import Fastify from 'fastify';
import { z } from 'zod';

/** The app's name: its tmux socket (`agent-cockpit-jobs-console`), its state folder, its lock. */
const APP_NAME = 'jobs-console';

/** One job: explain a file of the app's folder. Its key names the file, so each file has its session. */
const explainAFile = {
  id: 'explain',
  title: 'Explain a file',
  args: z.object({
    file: z.string().regex(/[A-Za-z0-9]/, 'Name a file: at least one letter or digit.'),
  }),
  key: ({ file }) => `explain-${slug(file)}`,
  prompt: ({ file }) => `Explain the file ${file} in a few sentences.`,
};

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const { values: options } = parseArgs({
  options: {
    real: { type: 'boolean', default: false },
    port: { type: 'string', default: '4310' },
  },
});

// The default is a stand-in for the agent's model, so that the example runs
// with no login and costs nothing. It is the example's, not the package's.
const agent = options.real ? yourOwnAgent() : await scriptedAgent();

const cockpit = await createCockpit({
  name: APP_NAME,
  directory: agent.directory,
  driver: claudeCode(),
  jobs: [explainAFile],
  ...(agent.stateDirectory === undefined ? {} : { stateDirectory: agent.stateDirectory }),
});

const app = Fastify();
await app.register(cockpitFastify(cockpit), { prefix: '/cockpit' });
for (const [path, file] of pageFiles()) {
  app.get(path, async (_request, reply) =>
    reply.type(CONTENT_TYPES[extname(file)]).send(await readFile(file)),
  );
}
await app.listen({ host: '127.0.0.1', port: Number(options.port) });

console.log(agent.description);
console.log(`Open ${cockpit.link(`http://127.0.0.1:${app.server.address().port}/`)}`);

// A second Ctrl+C while stopping changes nothing: the first one's stop goes on.
let stopRequested = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopRequested) return;
    stopRequested = true;
    stop().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

/**
 * Stops in order: the cockpit first (it closes the page's WebSockets, which
 * would hold the server open), then the server, then what the agent's mode
 * started. The sessions of your own agent go on in tmux; the scripted ones
 * end with their stand-in.
 */
async function stop() {
  try {
    await cockpit.close();
    await app.close();
  } finally {
    await agent.close();
  }
  console.log('Stopped.');
}

function yourOwnAgent() {
  return {
    description: `Your own agent: \`claude\` from your PATH, with your login, in ${process.cwd()}.`,
    directory: process.cwd(),
    close: async () => {},
  };
}

async function scriptedAgent() {
  // Loaded only in this mode: it needs the repository's development install.
  const { startScriptedAgent } = await import('./scripted-agent.js');
  const scripted = await startScriptedAgent(APP_NAME);
  return {
    description: `The scripted agent: the pinned Claude Code against a fake API, in ${scripted.root}.`,
    directory: scripted.workFolder,
    stateDirectory: scripted.stateFolder,
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
  const here = dirname(fileURLToPath(import.meta.url));
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
    ['/page.js', join(here, 'page', 'page.js')],
    ['/page.css', join(here, 'page', 'page.css')],
    ['/modules/xterm/xterm.mjs', join(packageOf('@xterm/xterm'), 'lib', 'xterm.mjs')],
    ['/modules/xterm/xterm.css', join(packageOf('@xterm/xterm'), 'css', 'xterm.css')],
    [
      '/modules/addon-fit/addon-fit.mjs',
      join(packageOf('@xterm/addon-fit'), 'lib', 'addon-fit.mjs'),
    ],
    ...cockpitModules,
  ]);
}
