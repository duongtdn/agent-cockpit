/**
 * Waits for a promise to settle, or for a signal to abort, whichever comes
 * first. Nothing of the wait is kept on the signal once it is over: a
 * signal that many waits race against, for as long as a process runs,
 * holds only those still waiting.
 *
 * @param promise - What is waited for; its outcome is not looked at.
 * @param signal - The abort that stops the wait.
 * @returns `true` once the promise settled, `false` once the signal
 * aborted first, or had aborted already.
 */
export function settlesBeforeAbort(
  promise: Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const aborted = () => resolve(false);
    signal.addEventListener('abort', aborted, { once: true });
    const settled = () => {
      signal.removeEventListener('abort', aborted);
      resolve(true);
    };
    promise.then(settled, settled);
  });
}
