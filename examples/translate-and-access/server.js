// Translate and access: an app on Fastify that shows who may reach its
// cockpit and how. On loopback, a page proves itself with the app's token,
// from the link printed here; the app's own API checks the same token. From
// another address, nothing is served unless the app opens itself (`--open`):
// then a page signs in with the app's password, and the cockpit's `authorize`
// checks the app's sign-in. The terminal stays on this machine either way.
//
//   node examples/translate-and-access/server.js             loopback only
//   --host <address>   where the server listens (127.0.0.1); 0.0.0.0 (:: for IPv6
//                      too) to be reached from the network, where the cockpit still
//                      refuses every page; the link is on that address, or on the
//                      loopback for a loopback or wildcard address
//   --open             opens the cockpit to signed-in pages of the network
//                      (listens on 0.0.0.0 unless --host says otherwise)
//   --origin <origin>  one more origin a page may come from, with --open
//                      (a name of this machine: http://my-box.local:4320); repeatable
//   --port <n>         the page's port (4320; 0 for any free one, without --open)
//   --real             your own `claude` and its login, instead of the scripted agent
//
// See DEMO.md. It imports the package by its name, as an app does: run
// `pnpm build` first.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCockpit } from '@duongtdn/agent-cockpit';
import { claudeCode } from '@duongtdn/agent-cockpit/claude-code';
import { cockpitFastify } from '@duongtdn/agent-cockpit/fastify';
import Fastify from 'fastify';
import { z } from 'zod';

/** The app's name: its tmux socket, its state folder, its lock. */
const APP_NAME = 'translate-and-access';

/** The cookie of the app's own sign-in, which a page of the network gets for the right password. */
const SIGN_IN_COOKIE = 'translate-and-access-sign-in';

/**
 * How long a sign-in lasts, in seconds: a working day. A stolen or
 * forgotten sign-in should not open the app for good; it ends sooner on a
 * sign-out, and when the server stops (the app keeps its sign-ins in memory).
 */
const SIGN_IN_LIFETIME_S = 8 * 60 * 60;

/** The addresses that listen on every address of the machine: IPv4's, and IPv6's (IPv4 too). */
const WILDCARD_HOSTS = ['0.0.0.0', '::'];
/** The loopback's names, which only this machine reaches. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** One job, so that there are sessions to follow and a terminal to keep local. */
const sayHello = {
  id: 'hello',
  title: 'Say hello',
  args: z.object({
    name: z
      .string()
      .regex(/[A-Za-z0-9]/, 'Give a name: at least one letter or digit.')
      // A key holds 100 characters at most: `hello-` and the slug fit.
      .max(80, 'Give a name of 80 characters at most.'),
  }),
  key: ({ name }) => `hello-${slug(name)}`,
  prompt: ({ name }) => `Say hello to ${name} in one sentence.`,
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
    port: { type: 'string', default: '4320' },
    host: { type: 'string' },
    open: { type: 'boolean', default: false },
    origin: { type: 'string', multiple: true, default: [] },
  },
});
const port = Number(options.port);
const host = options.host ?? (options.open ? '0.0.0.0' : '127.0.0.1');

if (options.open && port === 0) {
  // The origins the cockpit allows name the port, and they are given before the server listens.
  console.error('--open needs a fixed --port: the origins it allows name the port.');
  process.exit(2);
}

/**
 * The app's password, with `--open`: new at every start, printed only in this
 * terminal, so only who sees it can sign a page of the network in.
 */
const password = options.open ? randomBytes(18).toString('base64url') : undefined;
/** The sign-ins the app has given: the random value each cookie carries, and when it expires (ms). */
const signIns = new Map();

// Ctrl+C, a `kill`, or the terminal closing — at any time, while it starts
// too: the stop waits for what is starting, then stops all that started. A
// second signal while it stops forces the exit: a stop can hang (a request
// that never ends holds the server open), and a person presses Ctrl+C again.
let stopping;
let forcing = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping !== undefined) {
      void forceTheExit();
      return;
    }
    console.log('Stopping… (again to force it)');
    stopping = starting
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
// The default is a stand-in for the agent's model, so that the example runs
// with no login and costs nothing. It is the example's, not the package's.
// Held from the start: a forced stop removes it, however far the start went.
const agentStarting = options.real ? Promise.resolve(yourOwnAgent()) : scriptedAgent();
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
  if (!LOOPBACK_HOSTS.includes(host)) tellTheNetwork();
  console.log(`Open ${pageLink()}`);
}

async function start() {
  agent = await agentStarting;
  console.log(agent.description);
  cockpit = await createCockpit({
    name: APP_NAME,
    directory: agent.directory,
    driver: agent.driver(claudeCode()),
    jobs: [sayHello],
    // Every page of the network is refused, unless the app opens itself.
    ...(options.open ? openedToTheNetwork() : {}),
    // A terminal is a shell on this machine: a page of the network never gets one.
    terminal: 'loopback',
    ...(agent.stateDirectory === undefined ? {} : { stateDirectory: agent.stateDirectory }),
  });
  // What the cockpit answered with a bare 500, and an `authorize` that threw: the app's to know.
  cockpit.on('error', (failure) => {
    console.error(`The cockpit failed (${failure.where}):`, failure.cause);
  });
  app = Fastify();
  await app.register(cockpitFastify(cockpit), { prefix: '/cockpit' });
  await app.register(theApi, { prefix: '/api' });
  for (const [path, file] of pageFiles()) {
    app.get(path, async (_request, reply) =>
      reply.type(CONTENT_TYPES[extname(file)]).send(await readFile(file)),
    );
  }
  await app.listen({ host, port });
}

/**
 * The cockpit's options that open it to the network: a request from another
 * address is served when it carries the app's sign-in, and a page may come
 * from the addresses the app listens on at the app's port, or from an origin
 * the person named.
 */
function openedToTheNetwork() {
  return {
    authorize: (request) => signedIn(request),
    origins: [...networkOrigins(port), ...options.origin],
  };
}

/**
 * The app's own API, on routes of its own. A page's request proves itself
 * with the app's token (`cockpitHeaders()` on the page, `cockpit.verify`
 * here) or, from the network, with the app's sign-in; the page itself, a
 * navigation, carries neither, so the pages are served to anyone.
 *
 * Every route that changes something refuses a page of another origin. The
 * sign-in is a cookie, and a cookie is no proof of which page sent it: the
 * browser sends it to every port of its host, and `SameSite` counts every
 * port of a host as one site, so a page of any other server on this machine
 * (another user's included) would send it with a request to these routes.
 */
async function theApi(api) {
  api.addHook('onRequest', refuseOtherOrigins);

  api.get('/whoami', async (request, reply) => {
    const provedBy = proofOf(request);
    if (provedBy === undefined) return refuse(reply);
    return { provedBy, from: request.socket.remoteAddress };
  });

  // The token only, never a sign-in: renewing cuts every page of this
  // machine off until it opens the new link, which only this terminal shows.
  api.post('/renew-token', async (request, reply) => {
    if (!cockpit.verify(request)) {
      return reply
        .code(401)
        .send({ error: 'no-token', message: 'Only a page with the token renews it.' });
    }
    await cockpit.renewToken();
    console.log('Renewed the token: every page needs the new link.');
    console.log(`Open ${pageLink()}`);
    return reply.code(204).send();
  });

  api.post('/sign-in', async (request, reply) => {
    if (password === undefined) {
      return reply.code(403).send({ error: 'not-open', message: 'Started without --open.' });
    }
    if (!isThePassword(request.body?.password)) {
      return reply.code(403).send({ error: 'wrong-password', message: 'Not the password.' });
    }
    const signIn = randomBytes(32).toString('base64url');
    signIns.set(signIn, Date.now() + SIGN_IN_LIFETIME_S * 1000);
    // Sent back on every request of this address, WebSocket handshakes
    // included (a page can set no header on those): what `authorize` checks.
    // It expires with the sign-in, and the browser's copy with it.
    reply.header('set-cookie', signInCookie(signIn, SIGN_IN_LIFETIME_S));
    return reply.code(204).send();
  });

  // A shared or borrowed device must be able to give its access back.
  api.post('/sign-out', async (request, reply) => {
    signIns.delete(signInOf(request));
    reply.header('set-cookie', signInCookie('', 0));
    return reply.code(204).send();
  });
}

/**
 * Refuses a request that changes something when it comes from a page of
 * another origin than the app's own. Browsers send `Origin` with every such
 * request; one without it comes from no page (curl), and carries no cookie
 * of the person's browser. The origins are exact, port included: stricter
 * than the cockpit's check, which lets a page on any port of the loopback
 * through, since its proof, the token, is no cookie.
 */
async function refuseOtherOrigins(request, reply) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.origin;
  if (origin === undefined || appOrigins().includes(origin)) return;
  return reply
    .code(403)
    .send({ error: 'wrong-origin', message: `A page of ${origin} cannot change this app.` });
}

/** The origins of the app's own pages: the loopback, the addresses it listens on, the person's. */
function appOrigins() {
  const listening = app.server.address().port;
  return [
    `http://127.0.0.1:${listening}`,
    `http://localhost:${listening}`,
    ...networkOrigins(listening),
    ...options.origin,
  ];
}

/** How a request proves itself to the app's API: `'token'`, `'sign-in'`, or `undefined`. */
function proofOf(request) {
  if (cockpit.verify(request)) return 'token';
  if (signedIn(request)) return 'sign-in';
  return undefined;
}

function refuse(reply) {
  return reply.code(401).send({ error: 'no-proof', message: 'Neither the token nor a sign-in.' });
}

/** Whether a request carries a sign-in the app gave, and that has not expired. */
function signedIn(request) {
  const signIn = signInOf(request);
  const expires = signIns.get(signIn);
  if (expires === undefined) return false;
  if (expires > Date.now()) return true;
  signIns.delete(signIn);
  return false;
}

/** The sign-in a request's cookie carries; `undefined` for none. */
function signInOf(request) {
  const cookies = (request.headers.cookie ?? '').split(';').map((cookie) => cookie.trim());
  return cookies
    .find((cookie) => cookie.startsWith(`${SIGN_IN_COOKIE}=`))
    ?.slice(SIGN_IN_COOKIE.length + 1);
}

function signInCookie(value, lifetimeSeconds) {
  return `${SIGN_IN_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetimeSeconds}`;
}

function isThePassword(given) {
  if (typeof given !== 'string') return false;
  const expected = Buffer.from(password);
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The page's link, the app's token in its fragment: only this terminal shows
 * it. It is on the loopback when the app listens there (on every address
 * included), else on the address it listens on.
 */
function pageLink() {
  const listening = app.server.address().port;
  return cockpit.link(`http://${linkHost()}:${listening}/`);
}

function linkHost() {
  if (WILDCARD_HOSTS.includes(host) || host === '127.0.0.1' || host === 'localhost') {
    return '127.0.0.1';
  }
  // The cockpit knows the loopback by its names `127.0.0.1` and `localhost`, and
  // `localhost` reaches `::1`.
  if (host === '::1') return 'localhost';
  return inUrl(host);
}

/**
 * Where a page of the network reaches the app: every address of the machine
 * beyond the loopback when it listens on every one (IPv6's too for `::`), the
 * address it listens on otherwise; none on the loopback.
 */
function networkAddresses() {
  if (LOOPBACK_HOSTS.includes(host)) return [];
  if (!WILDCARD_HOSTS.includes(host)) return [host];
  const families = host === '::' ? ['IPv4', 'IPv6'] : ['IPv4'];
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => families.includes(entry.family) && !entry.internal)
    .map((entry) => entry.address);
}

/** The origins of the pages of the network, at a port. */
function networkOrigins(atPort) {
  return networkAddresses().map((address) => `http://${inUrl(address)}:${atPort}`);
}

/** An address as a URL names it: an IPv6 one in brackets. */
function inUrl(address) {
  return address.includes(':') ? `[${address}]` : address;
}

function tellTheNetwork() {
  if (WILDCARD_HOSTS.includes(host)) {
    for (const origin of networkOrigins(app.server.address().port)) {
      console.log(`From the network: ${origin}/`);
    }
  }
  console.log(
    password === undefined
      ? 'Not opened (--open): the cockpit refuses every page of the network.'
      : `Password for a page of the network: ${password}`,
  );
}

/**
 * Stops at once, on a second signal while the stop hangs: removes what the
 * scripted agent started (its sessions, their tmux server, its temporary
 * folder), then exits. The sessions of your own agent go on in tmux, as on
 * any stop.
 */
async function forceTheExit() {
  if (forcing) return;
  forcing = true;
  console.error('Forced to stop: removing what the scripted agent started.');
  try {
    const started = await agentStarting.catch(() => undefined);
    await started?.close();
  } finally {
    process.exit(1);
  }
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
