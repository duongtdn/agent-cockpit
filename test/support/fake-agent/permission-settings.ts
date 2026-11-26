/**
 * Reads the rules a settings file allows tool calls by, with no ask: the
 * `allow` of its `permissions`.
 *
 * @param text - The file's content, as JSON.
 * @returns The rules, as written; none when the file has no permissions.
 * @throws `Error` beginning "the fake agent cannot play" for what is no
 * JSON, and for permissions beyond a list of rules to allow: a list of
 * denials or of asks, a mode.
 */
export function parseAllowRules(text: string): readonly string[] {
  const permissions = permissionsIn(text);
  if (permissions === undefined) return [];
  if (!isRecord(permissions)) throw cannotPlay('permissions that are no object');
  const { allow = [], ...others } = permissions;
  const [unplayed] = Object.keys(others);
  if (unplayed !== undefined) {
    throw cannotPlay(
      `the ${JSON.stringify(unplayed)} of the permissions: it plays their "allow" only`,
    );
  }
  if (!Array.isArray(allow) || !allow.every((rule) => typeof rule === 'string')) {
    throw cannotPlay('an "allow" that is no list of rules');
  }
  return allow;
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
