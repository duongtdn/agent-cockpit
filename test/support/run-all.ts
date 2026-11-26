/**
 * Runs every step of an ending, in order, whatever the ones before did: a
 * step that fails must not keep the others from closing what they close.
 *
 * @param steps - What to run, each awaited before the next.
 * @throws The failure, when one step failed; an `AggregateError` whose
 * message lists every failure, when several did.
 */
export async function runAll(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, listed(failures));
}

function listed(failures: readonly unknown[]): string {
  const messages = failures.map((failure) =>
    failure instanceof Error ? failure.message : String(failure),
  );
  return [`${failures.length} failures:`, ...messages].join('\n');
}
