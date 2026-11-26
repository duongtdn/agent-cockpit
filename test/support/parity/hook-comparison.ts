/** A hook as a receiver got it, as far as two agents are compared on it. */
export interface ObservedHook {
  /** The event's name. */
  readonly event: string;
  /** The kind of hook that carried it. */
  readonly via: 'http' | 'command';
  /** The hook's payload. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** What a scenario gives each agent its own of: where one of them is expected, the other's would be wrong. */
export interface OwnValues {
  /** The id the session was launched with. */
  readonly sessionId: string;
  /** The folder the session was launched in. */
  readonly workFolder: string;
}

/**
 * How a value that two agents cannot share is compared: by where it comes
 * back (the same value wherever the first agent repeats one, another where
 * it has another), or by its type alone.
 */
export type Nature = 'recurrence' | 'type';

/**
 * The payload fields, by name and at any depth, whose values differ by
 * nature between two agents that played the same scenario. Every other
 * value is determined by the scenario, and compared as it is.
 */
export const VALUES_THAT_DIFFER_BY_NATURE: Readonly<Record<string, Nature>> = {
  // A path under each agent's own configuration folder: one file a conversation.
  transcript_path: 'recurrence',
  // Ids an agent draws: a prompt's is shared by the hooks of its turn, a call's by the hooks of the call.
  prompt_id: 'recurrence',
  tool_use_id: 'recurrence',
  turn_id: 'recurrence',
  message_id: 'recurrence',
  // How long a tool ran.
  duration_ms: 'type',
  // The full name the real agent resolves the launch's model to; the fake agent has no model.
  model: 'type',
  // What a resumed conversation costs to go on with: a clock, and counts of the model's tokens.
  seconds_since_last_response: 'type',
  context_tokens: 'type',
  estimated_cache_write_usd: 'type',
};

/**
 * Tells whether two hooks that arrived one right after the other may as
 * well have arrived the other way round, because the agent sends them
 * without waiting for the first: the two hooks of one event, a command and a
 * post, which run side by side; and a `MessageDisplay` with the `Stop`
 * that follows it, posted on a connection each. Nothing else may differ in
 * order.
 */
function arrivedEitherWay(first: ObservedHook, second: ObservedHook): boolean {
  const sameEventBothKinds = first.event === second.event && first.via !== second.via;
  const events = [first.event, second.event].sort().join(' ');
  return sameEventBothKinds || events === 'MessageDisplay Stop';
}

/** The order such a pair is compared in: the post before the command, the message before the end. */
function isInComparedOrder(first: ObservedHook, second: ObservedHook): boolean {
  return first.event === second.event ? first.via === 'http' : first.event === 'MessageDisplay';
}

function inComparedOrder(hooks: readonly ObservedHook[]): ObservedHook[] {
  const ordered = [...hooks];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const [first, second] = [ordered[index], ordered[index + 1]] as [ObservedHook, ObservedHook];
    if (arrivedEitherWay(first, second) && !isInComparedOrder(first, second)) {
      ordered.splice(index, 2, second, first);
    }
  }
  return ordered;
}

/** Names the values that come back, by field: the first of a field is 1, the next new one 2. */
function recurrenceNamer(): (field: string, value: string) => string {
  const seen = new Map<string, string[]>();
  return (field, value) => {
    const values = seen.get(field) ?? [];
    if (!values.includes(value)) seen.set(field, [...values, value]);
    return `<${field} ${(seen.get(field) as string[]).indexOf(value) + 1}>`;
  };
}

/**
 * Makes what a receiver got of one agent comparable with what it got of
 * another that played the same scenario: two agents agree when the results
 * are equal.
 *
 * The hooks keep their order, but for the pairs that may arrive either way
 * (a `MessageDisplay` and the `Stop` after it; the post and the command
 * of one event), which are put in one order. Each keeps its event, its
 * kind and every key of its payload. A value is kept as it is, unless it
 * is the agent's own session id or work folder, which is named as such, or
 * the value of a field of {@link VALUES_THAT_DIFFER_BY_NATURE}, which is
 * replaced by where it recurs or by its type.
 *
 * @param hooks - The hooks, in the order of arrival.
 * @param own - The session id and the work folder of the agent that sent them.
 * @returns The hooks, for `toEqual`.
 */
export function comparable(hooks: readonly ObservedHook[], own: OwnValues): ObservedHook[] {
  const named = recurrenceNamer();
  const ownNames = new Map([
    [own.sessionId, '<the session id>'],
    [own.workFolder, '<the work folder>'],
  ]);

  function comparedValue(field: string, value: unknown): unknown {
    const nature = Object.hasOwn(VALUES_THAT_DIFFER_BY_NATURE, field)
      ? VALUES_THAT_DIFFER_BY_NATURE[field]
      : undefined;
    if (nature === 'type') return `<${typeof value}>`;
    if (nature === 'recurrence' && typeof value === 'string') return named(field, value);
    if (typeof value === 'string') return ownNames.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => comparedValue(field, item));
    if (typeof value === 'object' && value !== null) return fieldsOf(value);
    return value;
  }

  function fieldsOf(fields: object): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [field, comparedValue(field, value)]),
    );
  }

  return inComparedOrder(hooks).map(({ event, via, payload }) => ({
    event,
    via,
    payload: fieldsOf(payload),
  }));
}
