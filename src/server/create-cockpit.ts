import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { CockpitError } from '../shared/cockpit-error.js';
import type { RunResult, Session } from '../shared/session.js';
import { openAgentListener } from './agent-listener/agent-listener.js';
import { type CockpitOptions, checkCockpitOptions } from './cockpit-options.js';
import { createHandler } from './http/handler.js';
import { type Job, launchOfJob } from './jobs.js';
import { createTmuxSessionHost } from './session-host/tmux-session-host.js';
import { createSessions, type Sessions } from './sessions/sessions.js';
import { openAppToken } from './state/app-token.js';
import { takeAppLock } from './state/lock.js';
import { openStateFolder, stateFolderPath } from './state/state-folder.js';

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
 * @throws `CockpitError` `invalid-options` with every issue of the options;
 * `unsupported-machine` when the machine is not Linux, or its tmux is
 * missing or too old; `cockpit-locked` when another process of the app runs
 * a cockpit.
 */
export async function createCockpit(options: CockpitOptions): Promise<Cockpit> {
  const checked = await checkCockpitOptions(options);
  checkPlatform(process.platform);
  const host = createTmuxSessionHost({ appName: checked.name });
  await host.checkMachine();
  const folder = await openStateFolder(stateFolderPath(checked.name, checked.stateDirectory));
  const lock = await takeAppLock(folder.path);
  try {
    const appToken = await openAppToken(folder.path);
    // The listener takes hooks only with a session's token, and none is
    // granted before the sessions exist: nothing reaches `receive` early.
    const receiver: { sessions?: Sessions } = {};
    const listener = await openAgentListener({
      folder: folder.path,
      ...(checked.agentPort === undefined ? {} : { agentPort: checked.agentPort }),
      receive: (request) => receiver.sessions?.receive(request),
    });
    const sessions = createSessions({
      host,
      driver: checked.driver,
      hooks: listener.hooks,
      folders: folder.sessions,
      environment: serverEnvironment,
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
    });
    let closing: Promise<void> | undefined;
    return {
      run,
      sessions: { list: () => sessions.list(), follow: (handler) => sessions.follow(handler) },
      link: (pageUrl) => linkTo(pageUrl, appToken.value),
      handle: handler.handle,
      upgrade: handler.upgrade,
      close() {
        closing ??= (async () => {
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
