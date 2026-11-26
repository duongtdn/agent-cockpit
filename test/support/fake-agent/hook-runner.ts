import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { type HookEvent, payloadOf, type SessionContext } from './hook-events.ts';
import { type CommandHook, type HookSettings, type HttpHook, hooksFor } from './hook-settings.ts';

/** Runs the hooks a session's settings configure. */
export interface HookRunner {
  /**
   * Tells whether the settings give an event any hook.
   *
   * @param event - The event's name.
   */
  configures(event: string): boolean;
  /**
   * Tells every hook of an event about it, and waits for their answers.
   *
   * @param event - What happened.
   * @param signal - Aborted to let go of the hooks still waiting: their
   * commands are killed and their connections closed.
   * @returns Each hook's answer as parsed JSON, in the order of the settings;
   * `{}` for a hook with no answer, as seen of Claude Code: a command that
   * succeeds and prints nothing, an HTTP hook whose address does not answer
   * or whose connection is cut, and a hook that was let go.
   * @throws `Error` naming the event and ending "the fake agent does not
   * play it", for a hook that fails any other way: a command that cannot run
   * or exits with a failure, an HTTP hook answered a status that is no
   * success, an answer that is no JSON. What Claude Code makes of those was
   * not observed.
   */
  fire(event: HookEvent, signal?: AbortSignal): Promise<unknown[]>;
}

/** The answer of a hook that gave none: no decision. */
const NO_ANSWER = {};

/**
 * Creates the runner of a session's hooks.
 *
 * @param settings - The hooks of the session's settings file.
 * @param session - What every payload says about the session.
 */
export function createHookRunner(settings: HookSettings, session: SessionContext): HookRunner {
  return {
    configures: (event) => hooksFor(settings, event).length > 0,
    fire(event, signal) {
      const firing: Firing = {
        event: event.name,
        payload: JSON.stringify(payloadOf(session, event)),
        abort: signal ? { signal } : {},
      };
      return Promise.all(
        hooksFor(settings, event.name).map((hook) =>
          hook.type === 'command'
            ? runCommandHook(hook, firing, session.cwd)
            : postHttpHook(hook, firing),
        ),
      );
    },
  };
}

/** One event as its hooks are told of it. */
interface Firing {
  /** The event's name, for a failure to say. */
  readonly event: string;
  /** The payload, as JSON. */
  readonly payload: string;
  /** How a waiting hook is let go, when it can be. */
  readonly abort: { readonly signal?: AbortSignal };
}

function isLetGo(firing: Firing): boolean {
  return firing.abort.signal?.aborted === true;
}

function notPlayed(firing: Firing, kind: 'command' | 'HTTP', failure: string): Error {
  return new Error(`a ${firing.event} ${kind} hook ${failure}: the fake agent does not play it`);
}

/**
 * Reads an answer as JSON.
 *
 * @throws The error `refuse` makes for a text that is none.
 */
function answerIn(text: string, refuse: (failure: string) => Error): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw refuse(`answered what is no JSON: ${JSON.stringify(text)}`);
  }
}

/** Runs a command hook in the session's folder: the payload on its input, its output the answer. */
function runCommandHook(hook: CommandHook, firing: Firing, cwd: string): Promise<unknown> {
  const refuse = (failure: string) => notPlayed(firing, 'command', failure);
  const answerOf = (status: number | null, output: string): unknown => {
    if (isLetGo(firing)) return NO_ANSWER;
    if (status !== 0) throw refuse(`exited with status ${status}`);
    // Seen of Claude Code: a hook that only reports prints nothing, and decides nothing.
    return output === '' ? NO_ANSWER : answerIn(output, refuse);
  };
  return new Promise((resolve, reject) => {
    const child = spawn(hook.command, {
      shell: true,
      cwd,
      // What a hook writes to its error output must not draw over the screen.
      stdio: ['pipe', 'pipe', 'ignore'],
      ...firing.abort,
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (error) => {
      if (isLetGo(firing)) resolve(NO_ANSWER);
      else reject(refuse(`could not run (${error.message})`));
    });
    child.on('close', (status) => {
      try {
        resolve(answerOf(status, output));
      } catch (error) {
        reject(error);
      }
    });
    // A command that ends without reading its input breaks the pipe; its status tells the rest.
    child.stdin.on('error', () => {});
    child.stdin.end(firing.payload);
  });
}

/** Posts an HTTP hook, on a connection of its own so that letting go of it closes the connection. */
function postHttpHook(hook: HttpHook, firing: Firing): Promise<unknown> {
  const refuse = (failure: string) => notPlayed(firing, 'HTTP', failure);
  const answerOf = (status: number | undefined, body: string): unknown => {
    if (!isSuccess(status)) throw refuse(`was answered the status ${status}`);
    return answerIn(body, refuse);
  };
  return new Promise((resolve, reject) => {
    // Seen of Claude Code: a hook whose address does not answer, or stops answering, decides nothing.
    const unanswered = () => resolve(NO_ANSWER);
    const posting = request(
      hook.url,
      {
        method: 'POST',
        agent: false,
        headers: { ...hook.headers, 'content-type': 'application/json' },
        ...firing.abort,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8').on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(answerOf(response.statusCode, body));
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', unanswered);
      },
    );
    posting.on('error', unanswered);
    posting.end(firing.payload);
  });
}

function isSuccess(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}
