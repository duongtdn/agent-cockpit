import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { type HookEvent, payloadOf, type SessionContext } from './hook-events.ts';
import { type CommandHook, type HookSettings, type HttpHook, hooksFor } from './hook-settings.ts';

/** Runs the hooks a session's settings configure. */
export interface HookRunner {
  /**
   * Tells every hook of an event about it, and waits for their answers.
   *
   * @param event - What happened.
   * @param signal - Aborted to let go of the hooks still waiting: their
   * commands are killed and their connections closed.
   * @returns Each hook's answer as parsed JSON, in the order of the settings;
   * `{}` for a hook that failed, was let go, or answered nothing that parses.
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
    fire(event, signal) {
      const payload = JSON.stringify(payloadOf(session, event));
      const abort = signal ? { signal } : {};
      return Promise.all(
        hooksFor(settings, event.name).map((hook) =>
          hook.type === 'command'
            ? runCommandHook(hook, payload, session.cwd, abort)
            : postHttpHook(hook, payload, abort),
        ),
      );
    },
  };
}

/** How a waiting hook is let go, when it can be. */
type Abort = { readonly signal?: AbortSignal };

/** Runs a command hook in the session's folder: the payload on its input, its output the answer. */
function runCommandHook(
  hook: CommandHook,
  payload: string,
  cwd: string,
  abort: Abort,
): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      shell: true,
      cwd,
      // What a hook writes to its error output must not draw over the screen.
      stdio: ['pipe', 'pipe', 'ignore'],
      ...abort,
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', () => resolve(NO_ANSWER));
    child.on('close', (status) => resolve(status === 0 ? answerIn(output) : NO_ANSWER));
    // A command that ends without reading its input breaks the pipe; its status tells the rest.
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

/** Posts an HTTP hook, on a connection of its own so that letting go of it closes the connection. */
function postHttpHook(hook: HttpHook, payload: string, abort: Abort): Promise<unknown> {
  return new Promise((resolve) => {
    const posting = request(
      hook.url,
      {
        method: 'POST',
        agent: false,
        headers: { ...hook.headers, 'content-type': 'application/json' },
        ...abort,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8').on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve(isSuccess(response.statusCode) ? answerIn(body) : NO_ANSWER),
        );
        response.on('error', () => resolve(NO_ANSWER));
      },
    );
    posting.on('error', () => resolve(NO_ANSWER));
    posting.end(payload);
  });
}

function isSuccess(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}

function answerIn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NO_ANSWER;
  }
}
