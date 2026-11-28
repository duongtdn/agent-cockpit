import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { CockpitError } from '../shared/cockpit-error.js';
import type { Choice, JobDescription } from '../shared/job.js';
import type {
  EndResult,
  InterruptResult,
  OpenOptions,
  OpenResult,
  RemoveResult,
  RunOptions,
  RunResult,
  SendResult,
  Session,
} from '../shared/session.js';
import { openAgentListener } from './agent-listener/agent-listener.js';
import {
  type AgentStatus,
  type CockpitStatus,
  createAgentStatus,
  type UntestedVersion,
} from './agent-status.js';
import { APP_PORT_SOURCE, createAppPorts, type LearnsAppPorts } from './app-ports.js';
import {
  type CheckedCockpitOptions,
  type CockpitOptions,
  checkCockpitOptions,
  jobPartIssues,
} from './cockpit-options.js';
import { confinementReader, givenAndRealPaths, holdsRuleSyntax } from './confinement.js';
import { createFailureReport, type FailureReport, type InternalFailure } from './failures.js';
import { createHandler } from './http/handler.js';
import { carriesAppToken, type RequestHeaders } from './http/request-token.js';
import { describeJob } from './job-descriptions.js';
import { choicesOf } from './job-options.js';
import { type Job, jobOf } from './jobs.js';
import type { SessionHost } from './session-host/session-host.js';
import { createTmuxSessionHost } from './session-host/tmux-session-host.js';
import { createJobRuns } from './sessions/job-runs.js';
import { createSessions, type Sessions } from './sessions/sessions.js';
import { openUnitsOfWork } from './sessions/units-of-work.js';
import { openAppToken } from './state/app-token.js';
import { takeAppLock } from './state/lock.js';
import { UntrustedStateError } from './state/own-files.js';
import { openRecordStore } from './state/records.js';
import { cockpitStateRoot, openStateFolder, stateFolderPath } from './state/state-folder.js';
import { createTerminalHolds } from './terminal-hold.js';

/** The fragment's key that carries the app's token in the page's link. */
const LINK_KEY = 'cockpit';

/**
 * The cockpit, created: the app's sessions, run from its jobs, and the
 * handler its server mounts for the browser.
 */
export interface Cockpit {
  /**
   * Runs a job: checks its arguments against the job's schema and each
   * value against its field's option source, derives the key and the
   * folder, and acts by the state of the key's unit of work. Calls on one
   * key run one at a time, each on the state the one before left.
   *
   * | State | Run |
   * |---|---|
   * | no record | Starts the agent with the prompt (`started`). |
   * | `ended` | Resumes the conversation with the prompt (`resumed`); starts a new one when the job is `fresh` (`started`, `fresh`), or when the agent no longer keeps it (`conversation-gone`). |
   * | `idle` | Types the prompt, the person's draft kept (`sent`). Launched with other settings (another job of the key, or the job changed): ended (`restarted`), then resumed with the run's settings and prompt (`resumed`, `settings-changed`). |
   * | `starting`, `busy`, `waiting` | Refused `wrong-state`. |
   *
   * A job with no prompt starts or resumes with none, and on a live
   * session has nothing to send (`nothing-to-send`, with the state),
   * unless its settings differ from an `idle` session's: then it is
   * restarted with none (`resumed`, `settings-changed`). With `fresh`, a
   * new conversation (`started`, `fresh-on-request`): a live `idle`,
   * `busy` or `waiting` session is ended first, `starting` refused. A
   * fresh start, either way, records the folder its job gives now.
   * A launch resolves once the session leaves `starting`: `busy` once the
   * agent took the prompt, `idle` for a job without one, `waiting` while a
   * start-up dialog waits for the person in the terminal, `ended` when the
   * agent exited before it took the prompt (`declined` when the person
   * left a dialog). A prompt too long for the agent's command line is
   * typed once the agent started: the run settles once the agent took it,
   * or the session ended (`ended`, whatever ended it), and fails as a send
   * does when it did not (the session `idle`, in its conversation, the run
   * not kept in the key's history). A start-up dialog shown before it is
   * typed parks the run: the session, `waiting`, is recorded at once and
   * the key's turn freed, so that the calls asked meanwhile act on it (a
   * `fresh` run or open ends it); the run's history entry is written once
   * it settles, in the order the calls were asked. A start that ended a session lists the background
   * tasks it stopped (`stoppedTasks`).
   *
   * @param jobId - The job's id.
   * @param args - The job's arguments.
   * @param options - `fresh`: start a new conversation for the key.
   * @returns What the run did, and the state it left the session in.
   * @throws `CockpitError` `unknown-job`, `invalid-arguments` (also for a
   * prompt that is empty or only whitespace); `not-a-choice` for a value
   * not among its field's choices; `folder-outside-app` when the job's
   * folder lies outside the app's; `folder-changed` when it is not the
   * folder the key's record keeps (never on a fresh start);
   * `prompt-too-long` over 100,000 characters; `wrong-state`;
   * `prompt-not-taken`; `session-cap-reached` at the cap with no session
   * to end; `invalid-options` when the job's driver part does not fit, or
   * opens the network of a cockpit opened beyond loopback that the app did
   * not accept, or when the environment the launch starts from keeps the
   * driver from confining its agent (500 on the wire); `agent-not-found`
   * when no agent is found on the launch's `PATH`, or the one found cannot
   * be run (it fails, hangs or prints no version to `--version`);
   * `agent-too-old` when it is older than the driver's tested range (a
   * newer one, or a suffixed build, runs, and `untested-version` tells it
   * once); `sandbox-unavailable` when the app asked for the agent's
   * sandbox and it cannot run; `unobservable` when the agent reported
   * nothing and its session was ended; `no-app-port` when no port of the
   * app's browser-facing server is known, so the session's sandbox could
   * not be kept from it. What the job's option sources and `directory`
   * throw. An `Error` with no code when the cockpit is closed before the
   * run settles, or was closed before it (500 on the wire): an agent
   * already started goes on in tmux.
   */
  run(jobId: string, args: unknown, options?: RunOptions): Promise<RunResult>;
  /**
   * Sends a prompt to a unit of work: typed into its `idle` session, the
   * person's draft kept (`sent`); an `ended` one resumed with the prompt at
   * launch and the settings of the key's last run, its job as the app
   * defines it now with its recorded arguments, every check of a run made
   * again (`resumed`; `started`, `conversation-gone` when the agent no
   * longer keeps the conversation). A send never begins a unit of work.
   *
   * @param key - The unit of work's key.
   * @param prompt - The prompt, at most 100,000 characters.
   * @returns What the send did and the state it left the session in.
   * @throws `CockpitError` `invalid-arguments` for a prompt that is empty
   * or only whitespace; `prompt-too-long`; `unknown-key` for a key with
   * no record, or whose history keeps no run; `unknown-job` when the job
   * of its last run is gone; `wrong-state` on `starting`, `busy` or
   * `waiting`, on a session being ended, or when the typing met anything
   * but the input box (its message says where the person's draft is when
   * it could not be put back); `prompt-not-taken`; and what a run throws.
   */
  send(key: string, prompt: string): Promise<SendResult>;
  /**
   * Opens a unit of work to type in: its `ended` session resumed with no
   * prompt and the settings of its last run, every check of a run made
   * again (`resumed`; `started`, `conversation-gone`). A live session, or a
   * key with no record, has nothing to open (`nothing-to-open`, with the
   * state when there is one). The open is kept in the key's history.
   *
   * @param key - The unit of work's key.
   * @param options - `fresh`: start a new conversation for the key
   * (`started`, `fresh-on-request`), ending its live session first.
   * @returns What the open did and the state it left the session in.
   * @throws `CockpitError` `unknown-job` when the job of its last run is
   * gone; `wrong-state` with `fresh` on `starting`; and what a run throws.
   */
  open(key: string, options?: OpenOptions): Promise<OpenResult>;
  /**
   * Interrupts the turn of a unit of work's session, once the calls asked
   * before it on the key settled: a send under way is waited for, and the
   * turn it began is the one interrupted. The driver presses its keys once
   * (for Claude Code, one Esc) and never again, whatever follows.
   *
   * | State | Interrupt |
   * |---|---|
   * | `busy`, `waiting` on an ask or a channel request (from features that add them) | The turn stopped: `interrupted` once the driver confirms the session `idle`. |
   * | `waiting` in the terminal (a start-up dialog, a panel, a screen the driver cannot read) | Nothing to interrupt, no key pressed: a person must act there. |
   * | `idle`, `ended`, no record | Nothing to interrupt. |
   * | `starting` | Refused `wrong-state`. |
   *
   * A prompt the agent took but had not begun on, withdrawn by the
   * interrupt into an empty input box, is cleared from the box. The
   * background tasks go on.
   *
   * @param key - The unit of work's key.
   * @returns `interrupted` with the state `idle` it confirmed (a turn may
   * have begun since: the list tells the state now); `nothing-to-interrupt`
   * with the session's state (none for a key with no record), also when
   * the session ended meanwhile.
   * @throws `CockpitError` `wrong-state` on `starting`;
   * `interrupt-unconfirmed` (`key`, the last state known) when the session
   * was not seen `idle` within the driver's bound (for Claude Code, 5
   * seconds): nothing more was pressed.
   * @throws The session host's error, with no code, when the host fails
   * while the keys are pressed. On the wire, a 500 with no body, and the
   * failure goes to `on('error')` as `internal-failure`. An `Error` with
   * no code once the cockpit is closed (500 on the wire).
   */
  interrupt(key: string): Promise<InterruptResult>;
  /**
   * Ends a unit of work's session, once the calls asked before it on the
   * key settled: its agent's process ended (for Claude Code, SIGTERM; after
   * 5 seconds its tmux session killed, then its process group), the session
   * `ended` with `reason: 'app'`, its conversation and record kept for a
   * later run, send or open to resume.
   *
   * | State | End |
   * |---|---|
   * | `idle`, `waiting` in the terminal | Ended at once, no key pressed. |
   * | `busy`, `waiting` on an ask or a channel request (from features that add them) | Its turn interrupted first, as `interrupt` does, then ended whether or not the interrupt was confirmed: the partial answer is kept in the conversation. A prompt the interrupt withdraws is left in the box: no key is pressed once the end was asked but the interrupt's own. |
   * | `ended`, no record | Nothing to end. |
   * | `starting` | Refused `wrong-state`. |
   *
   * A session the cockpit is ending already (the cap's end, a restart's,
   * the idle timeout's) has that end awaited, its reason kept. If that
   * end's kill fails, this end then ends the session as the table says
   * for its state then: a `busy` one has its turn interrupted first.
   *
   * @param key - The unit of work's key.
   * @returns `ended` once the agent's process is gone, with the background
   * tasks known running as it went, stopped with it (empty when none ran);
   * `nothing-to-end` with the session's state, none for a key with no
   * record.
   * @throws `CockpitError` `wrong-state` on `starting`.
   * @throws The session host's error, with no code, when the session
   * outlived the bound and could not be killed: the session is left live,
   * and a later end may kill it. On the wire, a 500 with no body, and the
   * failure goes to `on('error')` as `internal-failure`. An `Error` with no
   * code once the cockpit is closed.
   */
  end(key: string): Promise<EndResult>;
  /**
   * Removes a unit of work, once the calls asked before it on the key
   * settled: a live session ended first as `end` ends it, then everything
   * the cockpit wrote for the key deleted (its record, its session's
   * folder) and the key forgotten: it is no longer listed, followers are
   * told, and its next run starts a new conversation. The agent's own
   * files, its transcripts, are left where the agent keeps them.
   *
   * | State | Remove |
   * |---|---|
   * | `idle`, `busy`, `waiting` | Ended first as `end` ends it (`reason: 'app'`), then removed. |
   * | `ended` | Removed. |
   * | no record and no session | Nothing to remove. |
   * | `starting` | Refused `wrong-state`. |
   *
   * A key listed with no record (a first launch that failed) is removed as
   * any other. A remove that fails keeps the key's record, and a remove
   * asked again finishes.
   *
   * @param key - The unit of work's key.
   * @returns `removed`, with the background tasks stopped with the session
   * ended first (absent when none ran); `nothing-to-remove`.
   * @throws `CockpitError` `wrong-state` on `starting`.
   * @throws The session host's error, with no code, when the session could
   * not be killed, as `end` throws it: the session is left live, its
   * record kept. The file system's error when a file cannot be deleted:
   * the session ended, its record kept. On the wire either is a 500 with
   * no body, and goes to `on('error')` as `internal-failure`. An `Error`
   * with no code once the cockpit is closed.
   */
  remove(key: string): Promise<RemoveResult>;
  /**
   * Describes the app's jobs for the browser: each one's id, title,
   * description, schema as JSON Schema (the input it takes, each field's
   * `label` and `hint` kept), which fields have an option source and of
   * which kind, and whether it has a prompt. Never a job's key, prompt,
   * folder or driver part.
   *
   * @returns The jobs, in the order the app gave them.
   */
  jobs(): readonly JobDescription[];
  /**
   * Reads a field's choices from its job's option source, given the
   * arguments filled so far: the source sees the other fields' values, as
   * it does when a run is checked.
   *
   * @param jobId - The job's id.
   * @param field - The field.
   * @param argsSoFar - The arguments filled so far, checked against the
   * job's schema made partial; none when left out.
   * @returns The choices.
   * @throws `CockpitError` `unknown-job`; `invalid-arguments` for a field
   * with no source, or arguments that do not fit; `invalid-options` when
   * the source gives no list of choices. What the source throws.
   */
  options(jobId: string, field: string, argsSoFar?: unknown): Promise<readonly Choice[]>;
  /** The sessions of the units of work. */
  readonly sessions: {
    /**
     * Lists the sessions: each one's key, state, since when, what its state
     * carries, and its unit of work's record (its conversation, the earlier
     * ones, the history of its runs and opens). A key with a record and no
     * live session is listed `ended`; one recorded before the server
     * started, `lost`.
     */
    list(): readonly Session[];
    /**
     * Follows the sessions: the handler gets the list now, then at every
     * change. A handler that throws stops neither the others nor the
     * change: what it threw goes to `console.error`.
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
   * Tells the app, once per version in the process, that the agent a launch
   * runs is one the driver was not tested on — newer than any tested, or a
   * suffixed build (`2.1.340-beta`) not older than the tested range: the
   * session runs, and `status()` says the same.
   *
   * @param event - `'untested-version'`.
   * @param handler - Receives the version and the tested range; what it
   * throws goes to `console.error`, and the others are still told.
   * @returns A function that removes the handler.
   * @throws `TypeError` for an event the cockpit does not have.
   */
  on(event: 'untested-version', handler: (event: UntestedVersion) => void): () => void;
  /**
   * Tells the agent's version as last read — when the cockpit was created,
   * then at each launch — whether the driver was tested on it, and the
   * driver's tested range. No agent found leaves no version.
   *
   * @returns The status now.
   */
  status(): CockpitStatus;
  /**
   * Renews the app's token: a new one is written to the state folder and
   * put in force, and the one before is refused at once (`no-token`). Every
   * browser-facing WebSocket is closed, the terminals' among them, so that
   * each page that reconnects is checked again: pages need the new link,
   * which `link` then gives. A request or handshake whose admission
   * overlaps the renewal — the old token compared, or the app's `authorize`
   * still out — is never admitted: it is answered 503 with `Retry-After`
   * and a body that asks for it again, and comes back as a new request,
   * checked afresh (the client makes a request again once, its streams
   * and the terminal reconnect, none reporting an error).
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
   * Closes the cockpit: refuses every later request and call from the
   * moment it is called (`run`, `send`, `open`, `interrupt`, `end` and
   * `remove` reject with `SessionsClosedError`; one under way makes no folder and writes no
   * record from then on), answers 503 to each request whose admission is
   * still pending (an `authorize` still out among them), settles every run
   * still pending (it rejects), closes every WebSocket and detaches every
   * terminal, waits for the records being written, stops the agent-facing
   * listener and releases the app's lock. The sessions go on in tmux:
   * nothing is killed, and no timer of the cockpit's is left.
   */
  close(): Promise<void>;
}

/**
 * Creates the cockpit: checks the options and the machine, opens the state
 * folder, takes the app's lock (waiting a few seconds for a predecessor to
 * exit), opens the app's token and the agent-facing listener, reads the
 * agent's version for `status()` (no agent is no failure here: a launch
 * refuses it), loads the units of work's records (each key with no live
 * session listed `ended`), then resolves.
 *
 * @param options - See {@link CockpitOptions}.
 * @returns The cockpit.
 * @throws `CockpitError` `invalid-options` with every issue of the options,
 * or with one issue when the state folder, or a file the cockpit reads in
 * it, is not the cockpit's own (a symbolic link, not a folder or a regular
 * file, another user's) — on `stateDirectory` when the app named the
 * folder; with an issue for each state root whose path, as given or as
 * the system resolves it, holds a character a permission rule reads as
 * its own (`*`, `?`, `[`, `]`, `{`, `}`, `(`, `)`, `\`, a control
 * character), whose deny rules could miss it; with the driver's issues
 * (an empty path) when the server's environment keeps it from confining
 * its agent (for Claude Code, its configuration folder, `CLAUDE_CONFIG_DIR`
 * or the home's `.claude`, or the home, `HOME`, itself, that is relative
 * or holds such a character);
 * `unsupported-machine` when the machine is not Linux, or its tmux is
 * missing or too old; `cockpit-locked` when another process of the app runs
 * a cockpit.
 */
export async function createCockpit(options: CockpitOptions): Promise<Cockpit> {
  const checked = await checkCockpitOptions(options);
  checkPlatform(process.platform);
  const host = createTmuxSessionHost({
    appName: checked.name,
    hiddenVariables: checked.hiddenEnv,
  });
  await host.checkMachine();
  const statePath = stateFolderPath(checked.name, checked.stateDirectory);
  await refuseStateRootsRulesMisread(checked, statePath);
  await refuseUnconfinableEnvironment(checked);
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
    const agentStatus = createAgentStatus(checked.driver.testedRange);
    const environment = () => serverEnvironment(checked.hiddenEnv);
    await readAgentVersion(checked.driver, environment(), agentStatus);
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
    // The core holds a key while it types a prompt; the pty bridge's terminals join it.
    const holds = createTerminalHolds();
    const sessions = createSessions({
      host,
      driver: checked.driver,
      hooks: listener.hooks,
      folders: folder.sessions,
      environment,
      admitAgent: async (launchEnvironment) =>
        agentStatus.admit(await checked.driver.agentVersion(launchEnvironment)),
      confinement: confinementReader({
        stateRoots: stateRootsOf(checked, folder.path),
        appPorts: appPorts.current,
        listener: { host: '127.0.0.1', port: listener.port },
      }),
      holds,
    });
    receiver.sessions = sessions;
    const jobs = new Map<string, Job>(checked.jobs.map((job) => [job.id, job]));
    const units = await openUnitsOfWork({
      sessions,
      records: await openRecordStore(folder.path),
      jobs: createJobRuns({
        jobs,
        appFolder: checked.directory,
        partIssues: (job) => jobPartIssues(checked, job),
      }),
      driver: checked.driver,
      environment,
      folders: folder.sessions,
      ...(checked.maxSessions === undefined ? {} : { maxSessions: checked.maxSessions }),
      ...(checked.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: checked.idleTimeoutMs }),
    });
    const descriptions = checked.jobs.map(describeJob);
    const operations = {
      run: (jobId: string, args: unknown, options?: RunOptions): Promise<RunResult> =>
        units.run(jobId, args, options),
      send: (key: string, prompt: string): Promise<SendResult> => units.send(key, prompt),
      open: (key: string, options?: OpenOptions): Promise<OpenResult> => units.open(key, options),
      interrupt: (key: string): Promise<InterruptResult> => units.interrupt(key),
      end: (key: string): Promise<EndResult> => units.end(key),
      remove: (key: string): Promise<RemoveResult> => units.remove(key),
      jobs: (): readonly JobDescription[] => descriptions,
      options: async (jobId: string, field: string, argsSoFar?: unknown) =>
        choicesOf(jobOf(jobs, jobId), field, argsSoFar),
    } satisfies Pick<
      Cockpit,
      'run' | 'send' | 'open' | 'interrupt' | 'end' | 'remove' | 'jobs' | 'options'
    >;
    const handler = createHandler({
      tokenMatches: appToken.matches,
      operations,
      sessions: units,
      terminals: {
        attach: (key, size) => sessions.attach(key, size),
        isLive: (key) => host.isLive(key),
        joinHold: (key, terminal) => holds.join(key, terminal),
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
      await handler.renewToken(appToken.renew);
    };
    return {
      ...operations,
      sessions: { list: () => units.list(), follow: (handler) => units.follow(handler) },
      link: (pageUrl) => linkTo(pageUrl, appToken.value),
      verify: (request) => carriesAppToken(request, appToken.matches),
      on: eventsOf(failures, agentStatus),
      status: () => agentStatus.current(),
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
          // Before any wait: nothing asked from now on begins while the rest closes.
          const unitsClosed = units.close();
          // A renewal under way writes the token's file: it ends before the lock is released.
          await renewing;
          await handler.close();
          sessions.close();
          // So does a record under way: once the lock is released, the folder may be another process's.
          await unitsClosed;
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
 * Reads the agent's version as the cockpit is created, for `status()`. A
 * read that fails leaves the status unread: the cockpit runs no agent yet,
 * and a launch reads it again, failing then.
 */
async function readAgentVersion(
  driver: CheckedCockpitOptions['driver'],
  environment: Readonly<Record<string, string>>,
  agentStatus: AgentStatus,
): Promise<void> {
  try {
    agentStatus.record(await driver.agentVersion(environment));
  } catch {
    // Left unread: the first launch reads it, and rejects with the failure.
  }
}

/** The cockpit's `on`: each event's handlers to the part that tells it. */
function eventsOf(failures: FailureReport, agentStatus: AgentStatus): Cockpit['on'] {
  function on(event: 'error', handler: (error: InternalFailure) => void): () => void;
  function on(event: 'untested-version', handler: (event: UntestedVersion) => void): () => void;
  function on(
    event: string,
    handler: ((error: InternalFailure) => void) | ((event: UntestedVersion) => void),
  ): () => void {
    // The overloads pair each event with its handler's type.
    if (event === 'error') return failures.on(handler as (error: InternalFailure) => void);
    if (event === 'untested-version') {
      return agentStatus.onUntested(handler as (event: UntestedVersion) => void);
    }
    throw new TypeError(`The cockpit has no event ${JSON.stringify(event)}.`);
  }
  return on;
}

/**
 * Refuses a state root whose path, as given or as the system resolves it
 * (the folder made if missing), holds a character a deny rule reads as its
 * own: its rules could miss the folder. Checked before anything is
 * written.
 */
async function refuseStateRootsRulesMisread(
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
      if (!holdsRuleSyntax(path)) continue;
      issues.push({
        path: issuePath,
        message: `${what} ${path} holds a character a permission rule reads as its own (* ? [ ] { } ( ) \\ or a control character), so the rule keeping the agent out of it could miss it.`,
      });
    }
  }
  if (issues.length === 0) return;
  const message = "The cockpit's state folder cannot be kept from the agent.";
  throw new CockpitError('invalid-options', message, { issues });
}

/**
 * Refuses an environment in which the driver could not confine its agent
 * (for Claude Code, a configuration folder or a home its deny rules could
 * miss).
 * Checked before anything is written; each launch checks it again.
 */
async function refuseUnconfinableEnvironment(checked: CheckedCockpitOptions): Promise<void> {
  const issues = await checked.driver.environmentIssues(serverEnvironment(checked.hiddenEnv));
  if (issues.length === 0) return;
  throw new CockpitError(
    'invalid-options',
    "The agent's files cannot be kept from it in the environment it is launched with.",
    { issues },
  );
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
 * Checks that the machine is one the cockpit runs on: Linux, WSL2 included,
 * where its tests run. macOS comes once its tests pass.
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
 * The environment a launch starts from: the server's, read at each launch,
 * without the variables the app hides. The driver removes what its agent
 * must not inherit.
 */
function serverEnvironment(hidden: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !hidden.includes(entry[0]),
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
