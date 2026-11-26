import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { CockpitError } from '../shared/cockpit-error.js';
import type { RunResult, Session } from '../shared/session.js';
import { openAgentListener } from './agent-listener/agent-listener.js';
import { APP_PORT_SOURCE, createAppPorts, type LearnsAppPorts } from './app-ports.js';
import {
  type CheckedCockpitOptions,
  type CockpitOptions,
  checkCockpitOptions,
} from './cockpit-options.js';
import { confinementReader, givenAndRealPaths, holdsPatternCharacter } from './confinement.js';
import { createFailureReport, type InternalFailure } from './failures.js';
import { createHandler } from './http/handler.js';
import { carriesAppToken, type RequestHeaders } from './http/request-token.js';
import { type Job, launchOfJob } from './jobs.js';
import type { SessionHost } from './session-host/session-host.js';
import { createTmuxSessionHost } from './session-host/tmux-session-host.js';
import { createSessions, type Sessions } from './sessions/sessions.js';
import { openAppToken } from './state/app-token.js';
import { takeAppLock } from './state/lock.js';
import { UntrustedStateError } from './state/own-files.js';
import { cockpitStateRoot, openStateFolder, stateFolderPath } from './state/state-folder.js';

/** The fragment's key that carries the app's token in the page's link. */
const LINK_KEY = 'cockpit';

/**
 * The cockpit, created: the app's sessions, run from its jobs, and the
 * handler its server mounts for the browser.
 */
export interface Cockpit {
  /**
   * Runs a job: checks its arguments against the job's schema, derives the
   * key, and launches the agent on a key with no session. Resolves once the
   * session leaves `starting`.
   *
   * @param jobId - The job's id.
   * @param args - The job's arguments.
   * @returns `{ action: 'started', state }`: `busy` once the agent took the
   * prompt, `idle` for a job without one, `ended` when the agent exited
   * before it reported anything.
   * @throws `CockpitError` `unknown-job`, `invalid-arguments`;
   * `wrong-state` when the key has a session, whatever its state, in this
   * version; `unobservable` when the agent reported nothing and its session
   * was ended. An `Error` with no code when the cockpit is closed before the
   * run settles, or was closed before it (500 on the wire): an agent
   * already started goes on in tmux.
   */
  run(jobId: string, args: unknown): Promise<RunResult>;
  /** The sessions the cockpit launched. */
  readonly sessions: {
    /**
     * Lists the sessions: each one's key, state, since when, and what its
     * state carries.
     */
    list(): readonly Session[];
    /**
     * Follows the sessions: the handler gets the list now, then at every
     * change.
     *
     * @returns A function that stops following.
     */
    follow(handler: (sessions: readonly Session[]) => void): () => void;
  };
  /**
   * Gives the link the person opens: the page's URL with the app's token in
   * its fragment (`#cockpit=…`), which is never sent to a server.
   *
   * @param pageUrl - The app's page, an `http:` or `https:` URL; a fragment
   * it has is replaced.
   * @throws `CockpitError` `invalid-options` for any other URL.
   */
  link(pageUrl: string): string;
  /**
   * Tells whether a request carries the app's token, compared in constant
   * time: an HTTP request in its `cockpit-token` header (the client's
   * `cockpitHeaders()` gives it), a WebSocket handshake in its subprotocol.
   * It checks no address, so the app may guard its own routes with it, and
   * `authorize: (req) => cockpit.verify(req)` opens remote access by the
   * link.
   *
   * @param request - The request: Node's, or a framework's that keeps
   * Node's headers (Fastify's).
   * @returns `true` when it carries the app's token.
   */
  verify(request: RequestHeaders): boolean;
  /**
   * Tells the app of a failure the browser or the agent is not told of: the
   * handler's own (it answered 500), an `authorize` that threw or rejected
   * (the request was refused), the agent-facing listener's (it answered
   * 500). Each is an `internal-failure` whose `cause` is what was thrown.
   * While the app has no handler, they go to `console.error`.
   *
   * @param event - `'error'`.
   * @param handler - Receives each failure.
   * @returns A function that removes the handler.
   */
  on(event: 'error', handler: (error: InternalFailure) => void): () => void;
  /**
   * Renews the app's token: a new one is written to the state folder and
   * put in force, and the one before is refused at once (`no-token`). Every
   * browser-facing WebSocket is closed, the terminals' among them, so that
   * each page that reconnects is checked again: pages need the new link,
   * which `link` then gives.
   *
   * @returns A promise fulfilled once the new token is in force and every
   * socket closed.
   * @throws The file system's error when the new token cannot be written:
   * the token in force then stays, and no socket is closed. An `Error` with
   * no code once the cockpit is closed.
   */
  renewToken(): Promise<void>;
  /**
   * Serves an HTTP request of the browser's, mounted: the app gives it the
   * requests under its prefix, the prefix removed from `req.url`.
   */
  handle(request: IncomingMessage, response: ServerResponse): void;
  /** Serves a WebSocket upgrade of the browser's, mounted as `handle` is. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Closes the cockpit: refuses every later request and run, settles every
   * run still pending (it rejects), closes every WebSocket and detaches
   * every terminal, stops the agent-facing listener and releases the app's
   * lock. The sessions go on in tmux: nothing is killed, and no timer of the
   * cockpit's is left.
   */
  close(): Promise<void>;
}

/**
 * Creates the cockpit: checks the options and the machine, opens the state
 * folder, takes the app's lock (waiting a few seconds for a predecessor to
 * exit), opens the app's token and the agent-facing listener, then resolves.
 *
 * @param options - See {@link CockpitOptions}.
 * @returns The cockpit.
 * @throws `CockpitError` `invalid-options` with every issue of the options,
 * or with one issue when the state folder, or a file the cockpit reads in
 * it, is not the cockpit's own (a symbolic link, not a folder or a regular
 * file, another user's) — on `stateDirectory` when the app named the
 * folder; with an issue for each state root whose path, as given or as
 * the system resolves it, holds a character a permission rule reads as a
 * pattern (`*`, `?`, `[`, `]`, `{`, `}`), whose deny rules could miss it;
 * `unsupported-machine` when the machine is not Linux, or its tmux is
 * missing or too old; `cockpit-locked` when another process of the app runs
 * a cockpit.
 */
export async function createCockpit(options: CockpitOptions): Promise<Cockpit> {
  const checked = await checkCockpitOptions(options);
  checkPlatform(process.platform);
  const host = createTmuxSessionHost({ appName: checked.name });
  await host.checkMachine();
  const statePath = stateFolderPath(checked.name, checked.stateDirectory);
  await refusePatternedStateRoots(checked, statePath);
  try {
    return await openCockpit(checked, host, statePath);
  } catch (error) {
    if (!(error instanceof UntrustedStateError)) throw error;
    throw untrustedState(error, statePath, checked.stateDirectory !== undefined);
  }
}

/** Opens the state folder, takes the lock, and assembles the cockpit around them. */
async function openCockpit(
  checked: CheckedCockpitOptions,
  host: SessionHost,
  statePath: string,
): Promise<Cockpit & LearnsAppPorts> {
  const folder = await openStateFolder(statePath);
  const lock = await takeAppLock(folder.path);
  try {
    const appToken = await openAppToken(folder.path);
    const failures = createFailureReport();
    // The listener takes hooks only with a session's token, and none is
    // granted before the sessions exist: nothing reaches `receive` early.
    const receiver: { sessions?: Sessions } = {};
    const listener = await openAgentListener({
      folder: folder.path,
      ...(checked.agentPort === undefined ? {} : { agentPort: checked.agentPort }),
      receive: (request) => receiver.sessions?.receive(request),
      reportFailure: (cause) => failures.report('agent-listener', cause),
    });
    const appPorts = createAppPorts(checked.ports);
    const sessions = createSessions({
      host,
      driver: checked.driver,
      hooks: listener.hooks,
      folders: folder.sessions,
      environment: serverEnvironment,
      confinement: confinementReader({
        stateRoots: stateRootsOf(checked, folder.path),
        appPorts: appPorts.current,
        listener: { host: '127.0.0.1', port: listener.port },
      }),
    });
    receiver.sessions = sessions;
    const jobs = new Map<string, Job>(checked.jobs.map((job) => [job.id, job]));
    const run = (jobId: string, args: unknown): Promise<RunResult> =>
      Promise.resolve().then(() =>
        sessions.run({ ...launchOfJob(jobs, jobId, args), directory: checked.directory }),
      );
    const handler = createHandler({
      tokenMatches: appToken.matches,
      run,
      sessions,
      terminals: {
        attach: (key, size) => sessions.attach(key, size),
        isLive: (key) => host.isLive(key),
      },
      keyRules: checked.driver.terminalKeys,
      ...(checked.authorize === undefined ? {} : { authorize: checked.authorize }),
      origins: checked.origins,
      terminal: checked.terminal,
      reportFailure: failures.report,
    });
    let closing: Promise<void> | undefined;
    let renewing: Promise<void> = Promise.resolve();
    const renewToken = async (): Promise<void> => {
      // Once closed the lock is another process's to take, and the token's file with it.
      if (closing !== undefined) throw new Error('The cockpit is closed: it renews no token.');
      await appToken.renew();
      await handler.closeAllSockets();
    };
    return {
      run,
      sessions: { list: () => sessions.list(), follow: (handler) => sessions.follow(handler) },
      link: (pageUrl) => linkTo(pageUrl, appToken.value),
      verify: (request) => carriesAppToken(request, appToken.matches),
      on: (_event, handler) => failures.on(handler),
      renewToken() {
        const renewal = renewToken();
        renewing = Promise.all([renewing, renewal.catch(() => undefined)]).then(() => undefined);
        return renewal;
      },
      [APP_PORT_SOURCE]: appPorts.addSource,
      handle: handler.handle,
      upgrade: handler.upgrade,
      close() {
        closing ??= (async () => {
          // A renewal under way writes the token's file: it ends before the lock is released.
          await renewing;
          await handler.close();
          sessions.close();
          await listener.close();
          await lock.release();
        })();
        return closing;
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/**
 * Refuses a state root whose path, as given or as the system resolves it
 * (the folder made if missing), holds a character a deny rule reads as a
 * pattern: its rules could miss the folder. Checked before anything is
 * written.
 */
async function refusePatternedStateRoots(
  checked: CheckedCockpitOptions,
  statePath: string,
): Promise<void> {
  const roots = [
    { root: cockpitStateRoot(), issuePath: [] as string[], what: 'The default state root' },
  ];
  if (checked.stateDirectory !== undefined) {
    roots.push({ root: statePath, issuePath: ['stateDirectory'], what: 'The state folder' });
  }
  const issues = [];
  for (const { root, issuePath, what } of roots) {
    for (const path of await givenAndRealPaths([root])) {
      if (!holdsPatternCharacter(path)) continue;
      issues.push({
        path: issuePath,
        message: `${what} ${path} holds a character a permission rule reads as a pattern (* ? [ ] { }), so the rule keeping the agent out of it could miss it.`,
      });
    }
  }
  if (issues.length === 0) return;
  const message = "The cockpit's state folder cannot be kept from the agent.";
  throw new CockpitError('invalid-options', message, { issues });
}

/**
 * The state roots no session may reach: the default one, which holds every
 * app's state folder, and the folder the app names, wherever it lies.
 */
function stateRootsOf({ stateDirectory }: CockpitOptions, statePath: string): string[] {
  return stateDirectory === undefined ? [cockpitStateRoot()] : [cockpitStateRoot(), statePath];
}

/**
 * The refusal of a state folder the cockpit cannot call its own: an issue on
 * `stateDirectory` when the app named the folder, else on the options as a
 * whole, naming the default folder.
 */
function untrustedState(
  error: UntrustedStateError,
  statePath: string,
  named: boolean,
): CockpitError<'invalid-options'> {
  const why = `${error.message} The state folder must be the cockpit's own: a folder of the app's user, which no other user can write, and its files the user's.`;
  const issue = named
    ? { path: ['stateDirectory'], message: why }
    : { path: [], message: `The default state folder ${statePath}: ${why}` };
  return new CockpitError('invalid-options', "The cockpit's state folder cannot be trusted.", {
    issues: [issue],
  });
}

/**
 * Checks that the machine is one the cockpit runs on: Linux, WSL2 included
 * (ADR-0053). macOS comes once its tests pass.
 *
 * @param platform - The machine's platform, as Node names it.
 * @throws `CockpitError` `unsupported-machine` on any other.
 */
export function checkPlatform(platform: NodeJS.Platform): void {
  if (platform === 'linux') return;
  throw new CockpitError('unsupported-machine', `The cockpit runs on Linux, not on ${platform}.`, {
    what: 'platform',
    found: platform,
    required: 'linux',
  });
}

/**
 * The environment a launch starts from: the server's, read at each launch.
 * The driver removes what its agent must not inherit.
 */
function serverEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * Puts the app's token in a page's URL, as the fragment's `cockpit`.
 *
 * @throws `CockpitError` `invalid-options` for a URL that is not `http:` or `https:`.
 */
export function linkTo(pageUrl: string, token: string): string {
  let url: URL | undefined;
  try {
    url = new URL(pageUrl);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new CockpitError('invalid-options', 'The link needs the page’s URL, http: or https:.', {
      issues: [{ path: ['pageUrl'], message: 'Expected an absolute http: or https: URL.' }],
    });
  }
  url.hash = `${LINK_KEY}=${token}`;
  return url.href;
}
