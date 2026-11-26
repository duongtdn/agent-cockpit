import { CockpitError, type CockpitErrorCode } from '../shared/cockpit-error.js';
import { isRetryResponse, type RetryResponse } from '../shared/wire.js';

/**
 * An `unreachable` error: the server cannot be reached, or what answers is
 * not the cockpit (a proxy's page while the app restarts, a server of
 * another kind on the port).
 */
export function unreachable(message: string, cause?: unknown): CockpitError<'unreachable'> {
  return new CockpitError('unreachable', message, cause === undefined ? {} : { cause });
}

/**
 * What an answer that is no success says: the server's error, or that the
 * request is to be made again ({@link RetryResponse}: nothing of it was
 * served).
 */
export type AnswerFailure = { readonly error: CockpitError } | RetryResponse;

/**
 * Reads what an answer that is no success says, as the wire's body holds
 * it: a {@link RetryResponse}, or the `CockpitError` an `ErrorResponse`
 * carries, rebuilt with its code, message and fields. The HTTP status is
 * the wire's detail: only the body says what failed.
 *
 * @param answer - An answer whose status is not a success.
 * @returns The server's asking for the request again, or its error;
 * `unreachable` when the body holds neither, or breaks off as it is read
 * (the connection reset). It never rejects.
 */
export async function failureOfAnswer(answer: Response): Promise<AnswerFailure> {
  let text: string;
  try {
    text = await answer.text();
  } catch (cause) {
    return {
      error: unreachable(
        `The answer with status ${answer.status} broke off as it was read.`,
        cause,
      ),
    };
  }
  const body = parsedOrUndefined(text);
  if (isRetryResponse(body)) return { retry: true };
  const error = carriedError(body);
  if (error === undefined) {
    return { error: unreachable(`What answered with status ${answer.status} is not the cockpit.`) };
  }
  const { code, message, ...fields } = error;
  // Client and server ship as one version, so the code and its fields are
  // the server's own; the constructor drops whatever would touch the
  // error's identity.
  return { error: new CockpitError(code as CockpitErrorCode, message, fields as never) };
}

function parsedOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The error an `ErrorResponse` body carries, when it carries one. */
function carriedError(
  body: unknown,
): ({ code: string; message: string } & Record<string, unknown>) | undefined {
  const error = isObject(body) ? body.error : undefined;
  return isObject(error) && typeof error.code === 'string' && typeof error.message === 'string'
    ? (error as { code: string; message: string } & Record<string, unknown>)
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
