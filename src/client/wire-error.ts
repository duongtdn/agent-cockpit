import { CockpitError, type CockpitErrorCode } from '../shared/cockpit-error.js';

/**
 * An `unreachable` error: the server cannot be reached, or what answers is
 * not the cockpit (a proxy's page while the app restarts, a server of
 * another kind on the port).
 */
export function unreachable(message: string, cause?: unknown): CockpitError<'unreachable'> {
  return new CockpitError('unreachable', message, cause === undefined ? {} : { cause });
}

/**
 * Rebuilds the `CockpitError` an answer that is no success carries, code,
 * message and fields, as the wire's `ErrorResponse` holds it. The HTTP
 * status is the wire's detail: only the body says what failed.
 *
 * @param answer - An answer whose status is not a success.
 * @returns The server's error; `unreachable` when the body holds none, or
 * breaks off as it is read (the connection reset). It never rejects.
 */
export async function errorOfAnswer(answer: Response): Promise<CockpitError> {
  let body: string;
  try {
    body = await answer.text();
  } catch (cause) {
    return unreachable(`The answer with status ${answer.status} broke off as it was read.`, cause);
  }
  const error = carriedError(body);
  if (error === undefined) {
    return unreachable(`What answered with status ${answer.status} is not the cockpit.`);
  }
  const { code, message, ...fields } = error;
  // Client and server ship as one version, so the code and its fields are
  // the server's own; the constructor drops whatever would touch the
  // error's identity.
  return new CockpitError(code as CockpitErrorCode, message, fields as never);
}

/** The error an `ErrorResponse` body carries, when it carries one. */
function carriedError(
  body: string,
): ({ code: string; message: string } & Record<string, unknown>) | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = isObject(parsed) ? parsed.error : undefined;
  return isObject(error) && typeof error.code === 'string' && typeof error.message === 'string'
    ? (error as { code: string; message: string } & Record<string, unknown>)
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
