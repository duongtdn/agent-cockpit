import { isAbsolute, posix } from 'node:path';
import { holdsRuleSyntax } from '../server/confinement.js';
import type { AskOfCall, JsonValue } from '../server/driver.js';
import type { AskAnswer } from '../shared/ask.js';

/**
 * How Claude Code is answered on a held `PermissionRequest` hook: the
 * decision in its reply, and the session rule "remember" adds.
 *
 * @packageDocumentation
 */

/** A permission rule as the agent takes it in `addRules`: a tool, and what of it, or all of it. */
interface PermissionRule {
  readonly toolName: string;
  readonly ruleContent?: string;
}

/**
 * The tools on a file whose rule the agent honors, and the tool each rule
 * names: a `Write(...)` rule has no effect, while an `Edit` rule on a file
 * lets both `Write` and `Edit` of it run.
 */
const FILE_RULE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'Edit',
  Edit: 'Edit',
  Read: 'Read',
};

/**
 * The agent's other tools that read or write files by path, whose rule's
 * spelling no contract row holds: a rule of the tool's name alone would
 * reach every file, whatever path the call named, or none (a `Glob` or a
 * `Grep` may leave out its `path`).
 */
const UNSPELLED_FILE_TOOLS: ReadonlySet<string> = new Set([
  'NotebookEdit',
  'NotebookRead',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
]);

/**
 * The input fields by which a tool names a file or folder it works on: a
 * tool not known to work on files is taken as one when its input has one.
 */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'local_path'] as const;

/** A first word that names a program and nothing else: no path, no assignment, no quote. */
const BARE_PROGRAM_NAME = /^[A-Za-z0-9._-]+$/;

/** What makes a command more than one simple command, a line break aside (a rule character). */
const COMPOUND_SIGNS = /[;&|<>`()]|\$\(/;

/**
 * The reply that stops a turn holding a `PermissionRequest`: a deny that
 * interrupts, with no message, which the agent would show nowhere. The
 * agent closes the turn's other held hooks and writes one marker.
 */
export const INTERRUPT_REPLY = decisionReply({ behavior: 'deny', interrupt: true });

/**
 * Gives the reply to a held `PermissionRequest` that carries an answer: an
 * `allow`, an `allow` adding one session rule when the answer remembers,
 * or a `deny`, with the answer's message when it has one.
 *
 * "Remember" never adds a rule wider than the call the person saw: one
 * simple `Bash` command by its first word, any other by its exact line; a
 * `Write` or `Edit` as an `Edit` rule on the file's absolute path, a
 * `Read` as a `Read` rule on it; any other tool by its name. A rule that
 * cannot be spelled exactly is not written: the call is allowed once.
 *
 * @param ask - The ask, as the driver read it from the hook.
 * @param answer - The app's answer, already checked against its shape.
 * @returns The hook's reply body.
 */
export function permissionReply({ content }: AskOfCall, answer: AskAnswer): JsonValue {
  if (!answer.allow) {
    return decisionReply(
      answer.message === undefined
        ? { behavior: 'deny' }
        : { behavior: 'deny', message: answer.message },
    );
  }
  const rule =
    answer.remember === 'session' ? rememberedRule(content.tool, content.input) : undefined;
  if (rule === undefined) return decisionReply({ behavior: 'allow' });
  return decisionReply({
    behavior: 'allow',
    updatedPermissions: [
      { type: 'addRules', rules: [{ ...rule }], behavior: 'allow', destination: 'session' },
    ],
  });
}

function decisionReply(decision: { readonly [field: string]: JsonValue }): JsonValue {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/** The session rule that remembers a call, or none when no rule spells it exactly. */
function rememberedRule(
  tool: string,
  input: { readonly [field: string]: unknown },
): PermissionRule | undefined {
  if (holdsRuleSyntax(tool)) return undefined;
  if (tool === 'Bash') return commandRule(input.command);
  const fileRuleTool = FILE_RULE_TOOLS[tool];
  if (fileRuleTool !== undefined) return fileRule(fileRuleTool, input.file_path);
  if (UNSPELLED_FILE_TOOLS.has(tool) || PATH_FIELDS.some((field) => field in input)) {
    return undefined;
  }
  return { toolName: tool };
}

/**
 * A command's rule: its first word when it is one simple command, else its
 * exact line. An empty line has none: `Bash()` could read as every command.
 */
function commandRule(command: unknown): PermissionRule | undefined {
  if (typeof command !== 'string' || command.trim() === '' || holdsRuleSyntax(command)) {
    return undefined;
  }
  const firstWord = command.trim().split(/\s+/)[0] ?? '';
  const simple = BARE_PROGRAM_NAME.test(firstWord) && !COMPOUND_SIGNS.test(command);
  return { toolName: 'Bash', ruleContent: simple ? `${firstWord}:*` : command };
}

/**
 * A file's rule, on its absolute path spelled `//<path>`, the one spelling
 * the agent honors. A path the agent may resolve otherwise than as written
 * (relative, or with a `.`, `..`, doubled or trailing `/`) has none.
 */
function fileRule(toolName: string, path: unknown): PermissionRule | undefined {
  const exact =
    typeof path === 'string' &&
    isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.endsWith('/');
  if (!exact || holdsRuleSyntax(path)) return undefined;
  return { toolName, ruleContent: `/${path}` };
}
