/** A hook that runs a shell command, the payload on its standard input. */
export interface CommandHook {
  readonly type: 'command';
  /** The command line, run by a shell. */
  readonly command: string;
}

/** A hook that posts the payload to an address. */
export interface HttpHook {
  readonly type: 'http';
  /** Where the payload is posted. */
  readonly url: string;
  /** The headers of the request, as the settings give them. */
  readonly headers: Readonly<Record<string, string>>;
}

/** A hook of a settings file, of one of the two types the fake agent plays. */
export type HookDefinition = CommandHook | HttpHook;

/** Hooks that share a matcher. */
interface HookGroup {
  /** The tools the group is for; none, an empty one or `*` for all. */
  readonly matcher: string | undefined;
  readonly hooks: readonly HookDefinition[];
}

/** The hooks of a settings file: for each event, its groups in the order of the file. */
export type HookSettings = Readonly<Record<string, readonly HookGroup[]>>;

/**
 * Reads the hooks of a settings file; what else the file holds is not the
 * fake agent's to play.
 *
 * @param text - The file's content, as JSON.
 * @returns The hooks of each event.
 * @throws `SyntaxError` for what is no JSON; `Error` for a hook that is
 * neither a command nor an HTTP hook.
 */
export function parseHookSettings(text: string): HookSettings {
  const settings = JSON.parse(text) as { hooks?: Record<string, RawGroup[]> };
  return Object.fromEntries(
    Object.entries(settings.hooks ?? {}).map(([event, groups]) => [event, groups.map(readGroup)]),
  );
}

interface RawGroup {
  readonly matcher?: string;
  readonly hooks: readonly RawHook[];
}

interface RawHook {
  readonly type: string;
  readonly command?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
}

function readGroup(group: RawGroup): HookGroup {
  return { matcher: group.matcher, hooks: group.hooks.map(readHook) };
}

function readHook(hook: RawHook): HookDefinition {
  if (hook.type === 'command' && hook.command !== undefined) {
    return { type: 'command', command: hook.command };
  }
  if (hook.type === 'http' && hook.url !== undefined) {
    return { type: 'http', url: hook.url, headers: hook.headers ?? {} };
  }
  throw new Error(`the fake agent cannot play a hook of type "${hook.type}"`);
}

/**
 * Gives the hooks to run for an event.
 *
 * @param settings - The hooks of the session's settings file.
 * @param event - The event's name.
 * @param toolName - The tool of a tool event, which the matchers select on.
 * @returns The hooks, in the order of the file. `SessionStart` never gets an
 * HTTP hook: Claude Code does not post that event.
 */
export function hooksFor(
  settings: HookSettings,
  event: string,
  toolName: string | undefined,
): readonly HookDefinition[] {
  const hooks = (settings[event] ?? [])
    .filter((group) => matches(group.matcher, toolName))
    .flatMap((group) => group.hooks);
  return event === 'SessionStart' ? hooks.filter((hook) => hook.type === 'command') : hooks;
}

function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*' || toolName === undefined) {
    return true;
  }
  return new RegExp(`^(?:${matcher})$`).test(toolName);
}
