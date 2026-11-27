import type { DriverPart, LaunchCommand } from '../driver.js';
import type { SessionEnvironment, TerminalSize } from '../session-host/session-host.js';
import { SessionHostError } from '../session-host/session-host-error.js';
import type { SessionLifecycle } from './session-lifecycle.js';
import type { SessionsOptions } from './sessions.js';

/**
 * The terminal a session is started with, until a terminal attaches and
 * gives its own: wide enough that an agent's screen reads well when read
 * without a page.
 */
const DETACHED_SIZE: TerminalSize = { columns: 120, rows: 40 };

/** A session as a launch puts it on the host: what the sessions core keeps of it, in part. */
export interface Launchable<E extends Launchable<E>> {
  readonly key: string;
  /** The folder the agent works in. */
  readonly directory: string;
  /** The environment the launch starts from, which the driver is given. */
  readonly environment: Readonly<Record<string, string>>;
  /** The conversation the agent works in. */
  readonly conversationId: string;
  readonly lifecycle: SessionLifecycle;
  /**
   * The ended session of the key this launch replaces: listed until the
   * launch is, and back if it fails; let go once the launch is on the host.
   */
  replaces?: E;
}

/** What a launch passes the agent, beyond its session. */
export interface LaunchArguments {
  /** The prompt passed on the command line; none when it has none there. */
  readonly prompt: string | undefined;
  /** Whether the conversation is resumed. */
  readonly resume?: boolean;
  /** The job's driver part, checked. */
  readonly part?: DriverPart;
}

/** What the launches work with. */
export interface LaunchesOptions<E extends Launchable<E>>
  extends Pick<
    SessionsOptions,
    'host' | 'driver' | 'hooks' | 'folders' | 'admitAgent' | 'confinement'
  > {
  /** The sessions by key, which a launch takes its key in. */
  readonly entries: Map<string, E>;
  /** Aborted at the close: a launch not yet on the host goes no further. */
  readonly closing: AbortSignal;
  /** Tells the sessions' followers of a change. */
  readonly notify: () => void;
  /** What a launch stopped by the close fails with. */
  readonly refusal: (key: string) => unknown;
}

/**
 * The launches of the sessions core: each takes its key at once, then puts
 * its agent on the host, step by step, stopping at the first step after
 * the core closed.
 */
export class Launches<E extends Launchable<E>> {
  readonly #options: LaunchesOptions<E>;

  /** @param options - See {@link LaunchesOptions}. */
  constructor(options: LaunchesOptions<E>) {
    this.#options = options;
  }

  /**
   * Takes the key at once, so that a second launch of it is refused before
   * any wait.
   *
   * @param entry - The session, `reserved`.
   */
  reserve(entry: E): void {
    this.#options.entries.set(entry.key, entry);
  }

  /**
   * Puts a reserved session's agent on the host: the session is `live` once
   * this settles. A launch that fails gives the key back to what it held
   * before: its ended session, or nothing.
   *
   * @param entry - The session, reserved.
   * @param launch - What the agent is passed.
   * @throws `SessionHostError` `session-exists` when a session of the key
   * that an earlier process left lives on the host; what the close's
   * refusal gives once closed before the agent was put on the host; what
   * any step fails with.
   */
  async start(entry: E, launch: LaunchArguments): Promise<void> {
    let granted = false;
    try {
      await this.#step(entry, () => this.#refuseLeftOver(entry));
      await this.#step(entry, () => this.#options.admitAgent(entry.environment));
      entry.lifecycle.move('launching');
      this.#options.notify();
      const confinement = await this.#step(entry, () => this.#options.confinement());
      const files = await this.#step(entry, () => this.#options.folders.prepare(entry.key));
      const hooks = this.#options.hooks.grant(entry.key);
      granted = true;
      const command = await this.#step(entry, () =>
        this.#options.driver.launch({
          key: entry.key,
          conversationId: entry.conversationId,
          ...(launch.resume === true ? { resume: true } : {}),
          directory: entry.directory,
          files,
          hooks,
          ...(launch.prompt === undefined ? {} : { prompt: launch.prompt }),
          ...(launch.part === undefined ? {} : { part: launch.part }),
          environment: entry.environment,
          confinement,
        }),
      );
      await this.#options.host.start({
        name: entry.key,
        folder: entry.directory,
        command: command.command,
        args: command.args,
        environment: exactly(command),
        size: DETACHED_SIZE,
      });
    } catch (error) {
      if (granted) this.#options.hooks.revoke(entry.key);
      this.#unreserve(entry);
      throw error;
    }
    entry.lifecycle.move('live');
    delete entry.replaces;
  }

  /**
   * Runs a step of a launch not yet on the host, between two checks of the
   * close: nothing more is put on the host once the core is closed.
   */
  async #step<T>(entry: E, step: () => Promise<T>): Promise<T> {
    this.#refuseIfClosed(entry);
    const result = await step();
    this.#refuseIfClosed(entry);
    return result;
  }

  #refuseIfClosed(entry: E): void {
    if (this.#options.closing.aborted) throw this.#options.refusal(entry.key);
  }

  /**
   * Refuses a key whose session an earlier process left on the host, before
   * anything is written: its agent may read its settings again, and must
   * never be handed this launch's token.
   */
  async #refuseLeftOver(entry: E): Promise<void> {
    if (await this.#options.host.isLive(entry.key)) {
      throw new SessionHostError(
        'session-exists',
        `A session of the key ${entry.key} lives on the host, left by an earlier run.`,
      );
    }
  }

  /** Gives the key back to what it held before a launch that failed: its ended session, or nothing. */
  #unreserve(entry: E): void {
    const listed = !entry.lifecycle.isReserved;
    const { entries } = this.#options;
    if (entries.get(entry.key) === entry) {
      if (entry.replaces === undefined) entries.delete(entry.key);
      else entries.set(entry.key, entry.replaces);
    }
    if (listed) this.#options.notify();
  }
}

/**
 * The host gives a session the calling process's environment with changes;
 * the driver's is the agent's whole one, so every other variable is removed.
 */
function exactly(command: LaunchCommand): SessionEnvironment {
  const remove = Object.keys(process.env).filter(
    (name) => !Object.hasOwn(command.environment, name),
  );
  return { set: command.environment, remove };
}
