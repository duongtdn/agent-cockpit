import { apiError } from '../fake-api/script.ts';
import type { TurnFailure } from './hook-events.ts';

/** How a turn failed, as `StopFailure` and the screen tell it. */
export interface Failure {
  readonly error: TurnFailure;
  /** The text the agent shows, which is the turn's last message. */
  readonly message: string;
}

/** The failure of every turn of a session whose person declined the environment's key. */
export const NOT_LOGGED_IN: Failure = {
  error: 'authentication_failed',
  message: 'Not logged in · Please run /login',
};

/** How Claude Code 2.1.332 tells each status it was seen failing a turn on. */
const FAILURES: Readonly<
  Record<number, (status: number, text: string, gateway: string) => Failure>
> = {
  500: serverError,
  529: serverError,
  429: (_status, text) => ({
    error: 'rate_limit',
    message: `API Error: Request rejected (429) · ${text}`,
  }),
  401: loginError,
  403: loginError,
};

function serverError(status: number, text: string, gateway: string): Failure {
  return {
    error: 'server_error',
    message: `API Error: ${status} ${text}. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (${gateway}).`,
  };
}

function loginError(status: number, text: string): Failure {
  return {
    error: 'authentication_failed',
    message: `Please run /login · API Error: ${status} ${text}`,
  };
}

/**
 * Tells how a turn fails when the scripted API answers it with an error
 * status, with the API's own message for that status.
 *
 * @param status - The HTTP status.
 * @param apiBaseUrl - The API's address (`ANTHROPIC_BASE_URL`), which a
 * server error names.
 * @returns The failure.
 * @throws `Error` for a status no failure was observed for, and for a server
 * error with no API address: what it says of Anthropic's own API was not seen.
 */
export function failureOf(status: number, apiBaseUrl: string | undefined): Failure {
  const failure = FAILURES[status];
  if (failure === undefined) {
    throw new Error(
      `the script fails a turn on the status ${status}: what Claude Code makes of it was not observed (${Object.keys(FAILURES).join(', ')} were)`,
    );
  }
  const gateway = apiBaseUrl === undefined ? undefined : new URL(apiBaseUrl).host;
  if (failure === serverError && gateway === undefined) {
    throw new Error(
      'a server error with no ANTHROPIC_BASE_URL: what Claude Code says then was not observed',
    );
  }
  return failure(status, apiError(status).message, gateway ?? '');
}
