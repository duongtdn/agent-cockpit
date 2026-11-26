/** What the fake agent plays of a settings file's permissions. */
export interface PlayedPermissions {
  /** The rules that allow tool calls with no ask, as written. */
  readonly allowRules: readonly string[];
  /**
   * The paths denied: folders to `Read` and to `Edit`, and files to `Edit`,
   * each absolute or, for one denied under every folder, the end of its
   * path (`.claude/settings.json`, a folder's ending in `/`:
   * `.claude/hooks/`); a file's name may hold a wildcard (`*`), which
   * stands for any part of a name (`/config/.claude*.json`).
   */
  readonly deniedPaths: readonly string[];
}

/**
 * The deny rules the cockpit's confinement writes, each with the path it
 * denies: a folder to `Read` or `Edit` (`Read(//abs/**)`), a folder to
 * `Edit` under every folder (`Edit(//**\/.claude/hooks/**)`), a file to
 * `Edit` under every folder (`Edit(//**\/.claude/settings.json)`), at one
 * path (`Edit(//abs/settings.json)`), or by a name with a wildcard in one
 * folder (`Edit(//abs/.claude*.json)`).
 */
const PATH_DENIES: readonly RegExp[] = [
  /^(?:Read|Edit)\(\/(\/[^*]+)\/\*\*\)$/,
  /^Edit\(\/\/\*\*\/([^*]+\/)\*\*\)$/,
  /^Edit\(\/\/\*\*\/([^*]+)\)$/,
  /^Edit\(\/(\/[^*]+)\)$/,
  /^Edit\(\/(\/[^*]+\/[^/*]*\*[^/*]*)\)$/,
];

/**
 * Reads the permissions a settings file plays: the rules of its `allow`,
 * and the paths of its `deny`.
 *
 * @param text - The file's content, as JSON.
 * @returns What it plays; nothing when the file has no permissions.
 * @throws `Error` beginning "the fake agent cannot play" for what is no
 * JSON, for permissions beyond a list of rules to allow and a list of
 * paths to deny (a list of asks, a mode), and for a deny rule other than
 * one of {@link PATH_DENIES}.
 */
export function parsePermissions(text: string): PlayedPermissions {
  const permissions = permissionsIn(text);
  if (permissions === undefined) return { allowRules: [], deniedPaths: [] };
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
  return { allowRules: allow, deniedPaths: [...new Set(deny.map(deniedPathOf))] };
}

function deniedPathOf(rule: string): string {
  const path = PATH_DENIES.map((deny) => deny.exec(rule)?.[1]).find((found) => found !== undefined);
  if (path === undefined) {
    throw cannotPlay(
      `the deny rule ${JSON.stringify(rule)}: it plays a folder denied to Read or Edit, and a file denied to Edit, only`,
    );
  }
  return path;
}

/**
 * Tells which denied path a call names, in any text of its input: what
 * Claude Code answers such a call depends on the tool and on the sandbox,
 * which the fake agent does not play.
 *
 * @param input - The call's input.
 * @param paths - The denied paths, from {@link parsePermissions}.
 * @returns The first path named; `undefined` when the call names none.
 */
export function deniedPathNamedBy(input: unknown, paths: readonly string[]): string | undefined {
  const texts = textsIn(input);
  return paths.find((path) => texts.some((text) => namesPath(text, path)));
}

/** Whether a text names a denied path: holds it, a wildcard standing for any part of a name. */
function namesPath(text: string, path: string): boolean {
  if (!path.includes('*')) return text.includes(path);
  const [before = '', after = ''] = path.split('*');
  return new RegExp(`${escaped(before)}[^/\\s]*${escaped(after)}`).test(text);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
