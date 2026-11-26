import type { ToolInput } from './hook-events.ts';

/** What the hooks of a tool call decided: to let it run, to refuse it, or nothing. */
export type Decision =
  | {
      readonly behavior: 'allow';
      /** The input the call runs with instead of its own, when the hook gives one. */
      readonly updatedInput: ToolInput | undefined;
    }
  | {
      readonly behavior: 'deny';
      /** Whether the refusal also interrupts the turn. */
      readonly interrupts: boolean;
    }
  | { readonly behavior: 'none' };

/** The part of a hook's answer that decides: a `PreToolUse` hook's fields, or a `PermissionRequest` hook's `decision`. */
interface SpecificOutput {
  readonly permissionDecision?: unknown;
  readonly updatedInput?: ToolInput;
  readonly decision?: {
    readonly behavior?: unknown;
    readonly updatedInput?: ToolInput;
    readonly interrupt?: unknown;
  };
}

/**
 * Reads the decision in what the hooks of a tool call answered.
 *
 * @param outputs - Each hook's answer, as parsed JSON; anything else is no decision.
 * @returns The first decision among them, or `none`.
 * @throws `Error` for a `PreToolUse` hook's decision other than `allow` (a
 * `deny`, an `ask`): nothing observed of Claude Code tells what it does
 * with one, and reading it as no decision would be a guess.
 */
export function decisionOf(outputs: readonly unknown[]): Decision {
  for (const output of outputs) {
    const decision = decisionIn(specificOutputOf(output));
    if (decision.behavior !== 'none') return decision;
  }
  return { behavior: 'none' };
}

function specificOutputOf(output: unknown): SpecificOutput {
  const specific = (output as { hookSpecificOutput?: SpecificOutput } | null)?.hookSpecificOutput;
  return typeof specific === 'object' && specific !== null ? specific : {};
}

function decisionIn(specific: SpecificOutput): Decision {
  if (specific.permissionDecision === 'allow') {
    return { behavior: 'allow', updatedInput: specific.updatedInput };
  }
  if (specific.permissionDecision !== undefined) {
    const answered = JSON.stringify(specific.permissionDecision);
    throw new Error(
      `a PreToolUse hook answered ${answered}: nothing tells what Claude Code does with it`,
    );
  }
  if (specific.decision?.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: specific.decision.updatedInput };
  }
  if (specific.decision?.behavior === 'deny') {
    return { behavior: 'deny', interrupts: specific.decision.interrupt === true };
  }
  return { behavior: 'none' };
}
