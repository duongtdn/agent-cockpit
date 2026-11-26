/** A hook that runs a shell command, the payload on its standard input. */
export interface CommandHook {
  readonly type: 'command';
  /** The command line, run by a shell. */
  readonly command: string;
}

/** A hook that posts the payload to an address. */
export interface HttpHook {
  readonly type: 'http';
  /** Where the payload is posted: a plain `http` address. */
  readonly url: string;
  /** The headers of the request, as the settings give them. */
  readonly headers: Readonly<Record<string, string>>;
}

/** A hook of a settings file, of one of the two types the fake agent plays. */
export type HookDefinition = CommandHook | HttpHook;

/** Hooks of an event that the file groups: each group is for every tool. */
interface HookGroup {
  readonly hooks: readonly HookDefinition[];
}

/** The hooks of a settings file: for each event, its groups in the order of the file. */
export type HookSettings = Readonly<Record<string, readonly HookGroup[]>>;

/** The matchers that select every tool: the only ones the settings the fake agent plays have. */
const MATCHERS_OF_EVERY_TOOL: readonly (string | undefined)[] = [undefined, '', '*'];

/**
 * Reads the hooks of a settings file; what else the file holds is not the
 * fake agent's to play.
 *
 * @param text - The file's content, as JSON.
 * @returns The hooks of each event.
 * @throws `Error` beginning "the fake agent cannot play" for what is no
 * JSON, hooks that are not groups of hooks by event, a hook that is neither
 * a command nor an HTTP hook to a plain `http` address, and a matcher that
 * selects tools.
 */
export function parseHookSettings(text: string): HookSettings {
  const hooks = hooksIn(text);
  if (!isRecord(hooks)) throw cannotPlay('hooks that are no object of events');
  return Object.fromEntries(
    Object.entries(hooks).map(([event, groups]) => [event, readGroups(event, groups)]),
  );
}

function cannotPlay(what: string): Error {
  return new Error(`the fake agent cannot play ${what}`);
}

function hooksIn(text: string): unknown {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw cannotPlay('settings that are no JSON');
  }
  return (isRecord(settings) ? settings.hooks : undefined) ?? {};
}

function readGroups(event: string, groups: unknown): HookGroup[] {
  if (!Array.isArray(groups)) throw cannotPlay(`the hooks of ${event}: they are no list of groups`);
  return groups.map((group) => readGroup(event, group));
}

function readGroup(event: string, group: unknown): HookGroup {
  if (!isRecord(group) || !Array.isArray(group.hooks)) {
    throw cannotPlay(`a group of ${event} without its list of hooks`);
  }
  if (!MATCHERS_OF_EVERY_TOOL.includes(group.matcher as string | undefined)) {
    throw cannotPlay(
      `the matcher ${JSON.stringify(group.matcher)} of ${event}: it plays only groups for every tool`,
    );
  }
  return { hooks: group.hooks.map(readHook) };
}

function readHook(hook: unknown): HookDefinition {
  const { type, command, url, headers } = (isRecord(hook) ? hook : {}) as Partial<RawHook>;
  if (type === 'command' && typeof command === 'string') return { type, command };
  if (type !== 'http') throw cannotPlay(`a hook of type ${JSON.stringify(type)}`);
  // The hooks a session is given go to the loopback interface, which has no TLS.
  if (typeof url !== 'string' || !url.startsWith('http://')) {
    throw cannotPlay(
      `an HTTP hook to ${JSON.stringify(url)}: it posts to plain http addresses only`,
    );
  }
  return { type, url, headers: headers ?? {} };
}

interface RawHook {
  readonly type: unknown;
  readonly command: unknown;
  readonly url: unknown;
  readonly headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Gives the hooks to run for an event.
 *
 * @param settings - The hooks of the session's settings file.
 * @param event - The event's name.
 * @returns The hooks, in the order of the file. `SessionStart` never gets an
 * HTTP hook: Claude Code does not post that event.
 */
export function hooksFor(settings: HookSettings, event: string): readonly HookDefinition[] {
  const hooks = (settings[event] ?? []).flatMap((group) => group.hooks);
  return event === 'SessionStart' ? hooks.filter((hook) => hook.type === 'command') : hooks;
}
