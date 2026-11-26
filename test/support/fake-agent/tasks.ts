import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

/**
 * The file of a session's folder that keeps a fake agent's background tasks
 * from doing their work: while it exists, a subagent started in the
 * background waits, as one whose model has not answered yet.
 */
export const TASKS_GATE_FILE_NAME = '.fake-agent-hold-tasks';

/** How often a held task looks whether it may work, in milliseconds. */
const GATE_CHECK_MS = 10;

function gateOf(folder: string): string {
  return join(folder, TASKS_GATE_FILE_NAME);
}

/**
 * Holds the background tasks of the fake agents launched in a folder, for a
 * test of what happens while they run. Without it, a task does its work as
 * soon as the turn that started it ended.
 *
 * @param folder - The sessions' working folder; it must exist.
 */
export function holdTasks(folder: string): void {
  writeFileSync(gateOf(folder), '');
}

/** Lets the background tasks held in a folder do their work. */
export function releaseTasks(folder: string): void {
  rmSync(gateOf(folder), { force: true });
}

/**
 * Waits until nothing holds the background tasks of a folder.
 *
 * @returns A promise fulfilled at once when nothing holds them.
 */
export async function tasksReleased(folder: string): Promise<void> {
  while (existsSync(gateOf(folder))) await pause(GATE_CHECK_MS);
}

/** Draws a subagent's id as Claude Code does: `a` and sixteen hexadecimal digits. */
export function drawAgentId(): string {
  return `a${randomBytes(8).toString('hex')}`;
}

/** The files Claude Code keeps for a background task. */
export interface TaskFiles {
  /** Where the task's output goes, which the `Agent` call names. */
  readonly outputFile: string;
  /** Where the subagent's conversation is written, which its `SubagentStop` names. */
  readonly transcriptPath: string;
}

/** A task started in the background, as the `Agent` call's answer names it. */
export interface LaunchedTask {
  readonly agentId: string;
  readonly description: string;
  readonly prompt: string;
  /** The model the subagent runs on. */
  readonly model: string;
  readonly outputFile: string;
}

/** What the `Agent` tool answers, seen of Claude Code, for a subagent it started in the background. */
export function launchedTaskResponse(task: LaunchedTask): object {
  return {
    isAsync: true,
    status: 'async_launched',
    agentId: task.agentId,
    description: task.description,
    resolvedModel: task.model,
    prompt: task.prompt,
    outputFile: task.outputFile,
    canReadOutputFile: true,
    canContinueAgent: true,
  };
}

/** What the model is told of the `Agent` call, seen of Claude Code: one text block. */
export function launchedTaskResult(task: LaunchedTask): object[] {
  const text = [
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)',
    `agentId: ${task.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${task.agentId}', summary: '<5-10 word recap>' to continue this agent.)`,
    'The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.',
    "Do not duplicate this agent's work — avoid working with the same files or topics it is using.",
    `output_file: ${task.outputFile}`,
    "Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
  ].join('\n');
  return [{ type: 'text', text }];
}

/** How a background task ended, as its notification tells it. */
export interface FinishedTask extends LaunchedTask {
  /** The id of the `Agent` call that started it. */
  readonly toolUseId: string;
  /** The subagent's last text. */
  readonly result: string;
  /** How many tools it called. */
  readonly toolUses: number;
  /** How long it took, in milliseconds. */
  readonly durationMs: number;
}

/**
 * The prompt the session's own turn starts with when a background task
 * ended, seen of Claude Code. The fake agent has no model, and counts no
 * tokens.
 */
export function taskNotification(task: FinishedTask): string {
  return [
    '<task-notification>',
    `<task-id>${task.agentId}</task-id>`,
    `<tool-use-id>${task.toolUseId}</tool-use-id>`,
    `<output-file>${task.outputFile}</output-file>`,
    '<status>completed</status>',
    `<summary>Agent "${task.description}" finished</summary>`,
    '<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>',
    `<result>${task.result}</result>`,
    `<usage><subagent_tokens>0</subagent_tokens><tool_uses>${task.toolUses}</tool_uses><duration_ms>${task.durationMs}</duration_ms></usage>`,
    '</task-notification>',
  ].join('\n');
}
