import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { CockpitError } from '../../shared/cockpit-error.js';
import type {
  Attachment,
  Screen,
  SessionHost,
  SessionProcess,
  StartOptions,
  TerminalSize,
  TextPacing,
} from './session-host.js';
import { SessionHostError } from './session-host-error.js';
import { type AttachingTerminal, attachTerminal } from './tmux-attachment.js';
import { createTmuxClient, type TmuxClient, TmuxFailure } from './tmux-client.js';
import {
  attachedArguments,
  byteWrites,
  keyArguments,
  killArguments,
  LIST_ARGUMENTS,
  liveArguments,
  processArguments,
  SHUT_DOWN_ARGUMENTS,
  screenArguments,
  socketNameFor,
  startArguments,
  textWrites,
} from './tmux-commands.js';
import {
  parseLines,
  parseProcess,
  parseScreen,
  parseServer,
  parseVariableNames,
  serverExitedUnder,
  socketLeftBehind,
} from './tmux-replies.js';
import { startScript } from './tmux-start.js';
import { paneTerminalType } from './tmux-terminal.js';
import { isSupportedTmuxVersion, MINIMUM_TMUX_VERSION, parseTmuxVersion } from './tmux-version.js';

/** What the tmux session host is created with. */
export interface TmuxSessionHostOptions {
  /** The app's name: its sessions live on a tmux socket named after it. */
  readonly appName: string;
  /** The tmux program to run; `tmux`, found on the `PATH`, when left out. */
  readonly executable?: string;
  /**
   * How long, in milliseconds, tmux may take to answer one command, or to
   * attach a terminal, before the operation fails; 10 seconds when left out.
   */
  readonly timeoutMs?: number;
  /**
   * The variables of the server's environment the app hides
   * (`hiddenEnv`): no tmux process the host runs is given them, so a tmux
   * server it starts never has them, and each start removes them from the
   * global environment of a server that had them (one started by another
   * process). This is hygiene, not a boundary: a process of the same user,
   * a session's agent among them, can still read the app's own environment
   * in `/proc/<pid>/environ`, and that of a server started with them.
   */
  readonly hiddenVariables?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** How long a killed tmux server may take to exit. */
const SERVER_EXIT_TIMEOUT_MS = 5000;
const SERVER_EXIT_POLL_MS = 10;

/**
 * How often a shutdown asks a server that exits under it again: once is
 * enough to find it gone; the bound only keeps a tmux that never says so
 * from holding the shutdown forever.
 */
const SHUT_DOWN_ATTEMPTS = 3;

/** How often the host asks tmux whether a terminal is attached yet; tmux answers in a few milliseconds. */
const ATTACH_POLL_MS = 10;

/** The program that tells whether the machine describes a terminal type. */
const TERMINAL_DATABASE_PROGRAM = 'infocmp';

/**
 * Creates the session host that keeps sessions in tmux: one tmux session per
 * session, on a tmux server of the app's own, apart from the person's. It is
 * the only code of the cockpit that runs tmux.
 *
 * @param options - The app's name, and optionally the tmux program and how
 * long it may take.
 * @returns The host. Creating it runs nothing.
 */
export function createTmuxSessionHost(options: TmuxSessionHostOptions): SessionHost {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new TmuxSessionHost(
    createTmuxClient(
      socketNameFor(options.appName),
      options.executable ?? 'tmux',
      timeoutMs,
      options.hiddenVariables,
    ),
    timeoutMs,
    options.hiddenVariables ?? [],
  );
}

class TmuxSessionHost implements SessionHost {
  readonly #tmux: TmuxClient;
  readonly #timeoutMs: number;
  readonly #hiddenVariables: readonly string[];
  /** Asked of the machine once: its terminal database does not change under a running app. */
  #terminalType: Promise<string> | undefined;

  constructor(tmux: TmuxClient, timeoutMs: number, hiddenVariables: readonly string[]) {
    this.#tmux = tmux;
    this.#timeoutMs = timeoutMs;
    this.#hiddenVariables = hiddenVariables;
  }

  async checkMachine(): Promise<void> {
    const output = await this.#tmux.version().catch((error: unknown) => {
      throw error instanceof TmuxFailure && error.kind === 'not-installed'
        ? unsupportedTmux('none', error)
        : hostError(error);
    });
    const version = parseTmuxVersion(output);
    if (version === undefined) throw unsupportedTmux(output.trim());
    if (!isSupportedTmuxVersion(version)) throw unsupportedTmux(version.text);
  }

  async start(options: StartOptions): Promise<void> {
    const processEnvironment = this.#tmux.environment();
    const hiddenVariables = this.#hiddenVariables;
    // What cannot be a session is refused here, before anything runs: once
    // tmux waits for its commands, there is no one to refuse it to.
    startScript(options, {
      processEnvironment,
      serverVariables: [],
      hiddenVariables,
      terminalType: '',
    });
    await requireFolder(options.folder);
    this.#terminalType ??= paneTerminalType(TERMINAL_DATABASE_PROGRAM, this.#timeoutMs);
    const terminalType = await this.#terminalType;
    const marker = `cockpit-${randomUUID()}`;
    try {
      await this.#tmux.runAnswering(startArguments(marker), marker, (printed) =>
        startScript(options, {
          processEnvironment,
          serverVariables: parseVariableNames(printed),
          hiddenVariables,
          terminalType,
        }),
      );
    } catch (error) {
      throw startError(error);
    }
  }

  list(): Promise<string[]> {
    return whenAbsent([], async () => parseLines(await this.#run(LIST_ARGUMENTS)));
  }

  isLive(name: string): Promise<boolean> {
    return whenAbsent(false, async () => {
      await this.#run(liveArguments(name));
      return true;
    });
  }

  processOf(name: string): Promise<SessionProcess | undefined> {
    return whenAbsent(undefined, async () => parseProcess(await this.#run(processArguments(name))));
  }

  async sendText(name: string, text: string, pacing: TextPacing): Promise<void> {
    const writes = textWrites(name, text, pacing.chunkLength);
    for (const [index, write] of writes.entries()) {
      if (index > 0) await pause(pacing.pauseMs);
      await this.#run(write);
    }
  }

  async sendKeys(name: string, keys: readonly string[]): Promise<void> {
    await this.#run(keyArguments(name, keys));
  }

  async sendBytes(name: string, bytes: Uint8Array): Promise<void> {
    for (const write of byteWrites(name, bytes)) await this.#run(write);
  }

  async readScreen(name: string): Promise<Screen> {
    return parseScreen(await this.#run(screenArguments(name)));
  }

  async attach(name: string, size: TerminalSize): Promise<Attachment> {
    // A client that finds no session would start, print tmux's complaint as
    // if it were the session's output, and end.
    if (!(await this.isLive(name))) throw noSession(`No session ${name} lives.`);
    const terminal = attachTerminal(this.#tmux, name, size);
    try {
      await this.#attached(name, terminal);
    } catch (error) {
      await terminal.attachment.detach();
      throw error;
    }
    return terminal.attachment;
  }

  /** Waits until tmux lists the terminal's client among those of the session. */
  async #attached(name: string, terminal: AttachingTerminal): Promise<void> {
    const deadline = Date.now() + this.#timeoutMs;
    const client = String(terminal.clientPid);
    while (!parseLines(await this.#run(attachedArguments(name))).includes(client)) {
      if (terminal.hasEnded()) {
        throw new SessionHostError('host-failed', `The terminal of ${name} ended unattached.`);
      }
      if (Date.now() > deadline) {
        throw new SessionHostError(
          'host-failed',
          `tmux did not attach a terminal to ${name} within ${this.#timeoutMs} ms.`,
        );
      }
      await pause(ATTACH_POLL_MS);
    }
  }

  async countAttached(name: string): Promise<number> {
    return parseLines(await this.#run(attachedArguments(name))).length;
  }

  kill(name: string): Promise<'killed' | 'gone'> {
    return whenAbsent('gone', async () => {
      const { pid } = parseProcess(await this.#run(processArguments(name)));
      await this.#run(killArguments(name));
      // tmux only hangs the pane up: what ignores the hangup outlives the session.
      killProcessGroup(pid);
      return 'killed' as const;
    });
  }

  async shutDown(): Promise<void> {
    let printed: string | undefined;
    for (let attempt = 1; printed === undefined; attempt += 1) {
      try {
        printed = await this.#tmux.run(SHUT_DOWN_ARGUMENTS);
      } catch (error) {
        // No server runs: there is nothing to end, and none is started to end it.
        if (!(error instanceof TmuxFailure && error.kind === 'no-server')) throw hostError(error);
        // A server that exited under the call named no socket: the next call names it.
        if (serverExitedUnder(error.message) && attempt < SHUT_DOWN_ATTEMPTS) continue;
        return removeSocket(socketLeftBehind(error.message));
      }
    }
    const server = parseServer(printed);
    await processGone(server.pid);
    await removeSocket(server.socketPath);
  }

  /** Runs a tmux call, its failure told as the host's. */
  async #run(args: readonly string[]): Promise<string> {
    try {
      return await this.#tmux.run(args);
    } catch (error) {
      throw hostError(error);
    }
  }
}

function noSession(message: string, cause?: unknown): SessionHostError {
  return new SessionHostError('no-session', message, cause);
}

/** Tells a tmux failure as the session host's; anything else stays what it is. */
function hostError(error: unknown): unknown {
  if (!(error instanceof TmuxFailure)) return error;
  switch (error.kind) {
    case 'no-server':
    case 'no-session':
      return noSession(error.message, error);
    case 'duplicate-session':
      return new SessionHostError('session-exists', error.message, error);
    default:
      return new SessionHostError('host-failed', `tmux failed: ${error.message}`, error);
  }
}

/**
 * Tells the failure of a start. A start brings its server up, so a server it
 * cannot reach is the host's failure, never a session that does not live.
 */
function startError(error: unknown): unknown {
  const failure = hostError(error);
  return failure instanceof SessionHostError && failure.reason === 'no-session'
    ? new SessionHostError('host-failed', `tmux failed: ${failure.message}`, error)
    : failure;
}

/**
 * Answers `absent` for a session that does not live, where that is an
 * answer and no failure. What `ask` throws before it asks is a
 * rejection too.
 */
async function whenAbsent<Absent, Answer>(
  absent: Absent,
  ask: () => Promise<Answer>,
): Promise<Absent | Answer> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof SessionHostError && error.reason === 'no-session') return absent;
    throw error;
  }
}

function unsupportedTmux(found: string, cause?: unknown): CockpitError<'unsupported-machine'> {
  const required = `${MINIMUM_TMUX_VERSION.text} or later`;
  return new CockpitError(
    'unsupported-machine',
    `The cockpit needs tmux ${required}; this machine has ${found}.`,
    { what: 'tmux', found, required, cause },
  );
}

/** tmux starts a session in the home folder when it cannot use the one named. */
async function requireFolder(folder: string): Promise<void> {
  const isDirectory = await stat(folder).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (!isDirectory) throw new SessionHostError('no-folder', `No directory at ${folder}.`);
}

/** tmux leaves its socket's file behind; a later server takes the path anew. */
async function removeSocket(path: string | undefined): Promise<void> {
  if (path !== undefined) await rm(path, { force: true });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills the process group a pane's process leads, if any of it is still
 * alive: tmux starts each pane's process in a session of its own, and its
 * children stay in its group.
 */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Gone already, with its session.
  }
}

/** `kill-server` returns before the server has exited; a start right after would reach it dying. */
async function processGone(pid: number): Promise<void> {
  const deadline = Date.now() + SERVER_EXIT_TIMEOUT_MS;
  while (isRunning(pid)) {
    if (Date.now() > deadline) {
      throw new SessionHostError('host-failed', `The tmux server ${pid} did not exit.`);
    }
    await pause(SERVER_EXIT_POLL_MS);
  }
}
