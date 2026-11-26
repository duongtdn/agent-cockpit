/** What the fake agent plays of a settings file's permissions. */
export interface PlayedPermissions {
  /** The rules that allow tool calls with no ask, as written. */
  readonly allowRules: readonly string[];
  /** The folders denied to `Read` and to `Edit`, each an absolute path. */
  readonly deniedFolders: readonly string[];
}

/** A rule that denies a folder by its absolute path, as the cockpit's confinement writes it. */
const FOLDER_DENY = /^(?:Read|Edit)\(\/(\/.+)\/\*\*\)$/;

/**
 * Reads the permissions a settings file plays: the rules of its `allow`,
 * and the folders of its `deny`.
 *
 * @param text - The file's content, as JSON.
 * @returns What it plays; nothing when the file has no permissions.
 * @throws `Error` beginning "the fake agent cannot play" for what is no
 * JSON, for permissions beyond a list of rules to allow and a list of
 * folders to deny (a list of asks, a mode), and for a deny rule other than
 * a folder's to `Read` or `Edit` (`Read(//abs/**)`).
 */
export function parsePermissions(text: string): PlayedPermissions {
  const permissions = permissionsIn(text);
  if (permissions === undefined) return { allowRules: [], deniedFolders: [] };
  if (!isRecord(permissions)) throw cannotPlay('permissions that are no object');
  const { allow = [], deny = [], ...others } = permissions;
  const [unplayed] = Object.keys(others);
  if (unplayed !== undefined) {
    throw cannotPlay(
      `the ${JSON.stringify(unplayed)} of the permissions: it plays their "allow" and "deny" only`,
    );
  }
  if (!isRuleList(allow)) throw cannotPlay('an "allow" that is no list of rules');
  if (!isRuleList(deny)) throw cannotPlay('a "deny" that is no list of rules');
  return { allowRules: allow, deniedFolders: [...new Set(deny.map(deniedFolderOf))] };
}

function deniedFolderOf(rule: string): string {
  const folder = FOLDER_DENY.exec(rule)?.[1];
  if (folder === undefined) {
    throw cannotPlay(
      `the deny rule ${JSON.stringify(rule)}: it plays a folder denied to Read or Edit only`,
    );
  }
  return folder;
}

/**
 * Tells which denied folder a call names, in any text of its input: what
 * Claude Code answers such a call depends on the tool and on the sandbox,
 * which the fake agent does not play.
 *
 * @param input - The call's input.
 * @param folders - The denied folders, from {@link parsePermissions}.
 * @returns The first folder named; `undefined` when the call names none.
 */
export function deniedFolderNamedBy(
  input: unknown,
  folders: readonly string[],
): string | undefined {
  const texts = textsIn(input);
  return folders.find((folder) => texts.some((text) => text.includes(folder)));
}

function textsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textsIn);
  if (isRecord(value)) return Object.values(value).flatMap(textsIn);
  return [];
}

function isRuleList(rules: unknown): rules is string[] {
  return Array.isArray(rules) && rules.every((rule) => typeof rule === 'string');
}

/**
 * Tells whether the rules allow every call of a tool. Seen of Claude Code:
 * a rule that is the tool's name does.
 *
 * @param rules - The rules, from {@link parseAllowRules}.
 * @param toolName - The tool's name.
 * @throws `Error` naming the rule, for a tool with a rule for some of its
 * calls only (`Bash(ls:*)`): which calls it allows is Claude Code's to say.
 */
export function allowsEveryCallOf(rules: readonly string[], toolName: string): boolean {
  if (rules.includes(toolName)) return true;
  const partial = rules.find((rule) => rule.startsWith(`${toolName}(`));
  if (partial === undefined) return false;
  throw new Error(
    `nothing tells whether the rule ${JSON.stringify(partial)} of the settings allows this call of ${toolName}`,
  );
}

function cannotPlay(what: string): Error {
  return new Error(`the fake agent cannot play ${what}`);
}

function permissionsIn(text: string): unknown {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw cannotPlay('settings that are no JSON');
  }
  return isRecord(settings) ? settings.permissions : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
