/**
 * Why a session host could not do what was asked:
 *
 * - `session-exists`: a start named a session that lives;
 * - `no-session`: the session named does not live (any more);
 * - `no-folder`: a start named a folder that is no directory;
 * - `host-failed`: the host itself failed, in a way no caller can mend.
 */
export type SessionHostFailure = 'session-exists' | 'no-session' | 'no-folder' | 'host-failed';

/**
 * A failure of the session host that the cockpit's design gives no code: it
 * never reaches an app as it is. The core either handles it by its `reason`
 * or lets it surface as an unexpected error.
 */
export class SessionHostError extends Error {
  override readonly name = 'SessionHostError';
  /** What went wrong, for the caller to branch on. */
  readonly reason: SessionHostFailure;

  /**
   * @param reason - What went wrong.
   * @param message - An English sentence for logs and developers.
   * @param cause - The error that lies under it, when there is one.
   */
  constructor(reason: SessionHostFailure, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.reason = reason;
  }
}
