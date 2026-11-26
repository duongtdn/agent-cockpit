import { fileURLToPath } from 'node:url';

/** A program and the arguments that come before its own. */
export interface AgentCommand {
  /** The program to run. */
  readonly command: string;
  /** The arguments to put before the command line of Claude Code. */
  readonly args: readonly string[];
}

/**
 * Gives the command that runs the fake agent in place of Claude Code: the
 * Node that runs the test, with the fake agent's entry as its first argument.
 * Claude Code's own arguments follow.
 */
export function fakeAgentCommand(): AgentCommand {
  const entry = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
  return { command: process.execPath, args: [entry] };
}
