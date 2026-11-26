import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { findTranscript } from '../transcript-files.ts';
import { CANNOT_PLAY_STATUS, createFakeAgent, type FakeAgent } from './agent.ts';
import type { TerminalSize } from './box-layout.ts';
import { type CommandLine, parseCommandLine } from './command-line.ts';
import { type AgentConfiguration, keySuffixOf, readConfiguration } from './configuration.ts';
import { sessionEnd } from './hook-events.ts';
import { createHookRunner, type HookRunner } from './hook-runner.ts';
import { type HookSettings, parseHookSettings } from './hook-settings.ts';
import { createKeyDecoder, type Key } from './keys.ts';
import { type PlayedPermissions, parsePermissions } from './permission-settings.ts';
import { drawScreen, type ScreenView } from './screen.ts';
import { readScript } from './script.ts';
import { startReleased } from './start-gate.ts';
import { type TaskFiles, tasksReleased } from './tasks.ts';
import {
  countPrompts,
  openTranscript,
  projectFolderName,
  secondsSinceLastResponse,
  transcriptPathFor,
} from './transcript.ts';
import { fakeAgentVersion, versionOutput } from './version.ts';

/**
 * How long an ESC waits for what follows before it is the Escape key: longer
 * than the bytes of one key take to arrive, shorter than a person notices.
 */
const ESCAPE_WAIT_MS = 50;

const CLEAR_SCREEN = '\x1b[H\x1b[2J';

/** Ends the process at once, saying why, as a program that cannot start does. */
function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readCommandLine(): CommandLine {
  try {
    return parseCommandLine(process.argv.slice(2));
  } catch (error) {
    refuse(`fake agent: ${(error as Error).message}`);
  }
}

/**
 * The configuration folder is where the transcripts go. Without one of the
 * test's, the fake agent would write into the person's own.
 */
function configFolder(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ??
    refuse('fake agent: CLAUDE_CONFIG_DIR is not set, and it writes only where a test tells it to')
  );
}

/**
 * Finds where the conversation is written: for a resumed one, where it
 * already is; none when it has no transcript (gone, or never prompted).
 */
function transcriptPathOf(commandLine: CommandLine, cwd: string): string | undefined {
  if (!commandLine.resumes) return transcriptPathFor(configFolder(), cwd, commandLine.sessionId);
  return findTranscript(configFolder(), commandLine.sessionId);
}

/**
 * Leaves as Claude Code (2.1.332) was seen to on `--resume` of a
 * conversation with no transcript, deleted or never prompted: it says so,
 * fires `SessionEnd` with the reason `other` and the id it was given, and
 * exits with 1 — no `SessionStart`, no dialog, no file written.
 */
async function leaveForAMissingConversation(
  hooks: HookRunner,
  configuration: AgentConfiguration,
): Promise<never> {
  if (configuration.startUpDialogs.length > 0) {
    refuseToPlay(
      new Error(
        '--resume of a missing conversation where a start-up dialog would show: not observed',
      ),
    );
  }
  process.stderr.write(`No conversation found with session ID: ${commandLine.sessionId}\n`);
  try {
    await hooks.fire(sessionEnd('other'));
  } catch (error) {
    refuseToPlay(error);
  }
  process.exit(MISSING_CONVERSATION_STATUS);
}

/** The status Claude Code exits with when `--resume` finds no conversation. */
const MISSING_CONVERSATION_STATUS = 1;

/**
 * Tells whether every prompt Up could show is this process's own: a new
 * conversation, and no other in the folder's project. Claude Code shows the
 * prompts of the project's earlier sessions too, in a way not made out.
 */
function historyIsOwn(commandLine: CommandLine, cwd: string): boolean {
  if (commandLine.resumes) return false;
  const project = dirname(transcriptPathFor(configFolder(), cwd, commandLine.sessionId));
  return !existsSync(project) || readdirSync(project).every((name) => !name.endsWith('.jsonl'));
}

/** The terminal's size now; a terminal that does not say its own counts as the usual 80×24. */
function terminalSize(): TerminalSize {
  return { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

/** Ends the process at once on settings it has no evidence for, as on anything else it cannot play. */
function refuseToPlay(error: unknown): never {
  process.stderr.write(`fake agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(CANNOT_PLAY_STATUS);
}

/** What the fake agent plays of a settings file. */
interface PlayedSettings extends PlayedPermissions {
  readonly hooks: HookSettings;
}

function settingsOf(commandLine: CommandLine): PlayedSettings {
  if (commandLine.settingsFile === undefined) return { hooks: {}, allowRules: [], deniedPaths: [] };
  try {
    const text = readFileSync(commandLine.settingsFile, 'utf8');
    return { hooks: parseHookSettings(text), ...parsePermissions(text) };
  } catch (error) {
    refuseToPlay(error);
  }
}

/** Draws the screen, then puts the terminal's cursor where Claude Code puts it: on the input box's. */
function show(view: ScreenView): void {
  const { rows, cursor } = drawScreen(view, process.stdout.columns);
  const up = cursor === undefined || cursor.rowsUp === 0 ? '' : `\x1b[${cursor.rowsUp}A`;
  const placed = cursor === undefined ? '' : `${up}\x1b[${cursor.column + 1}G`;
  process.stdout.write(CLEAR_SCREEN + rows.join('\r\n') + placed);
}

/** Reads what the configuration shows at the start; what it cannot play ends the process at once. */
function configurationOf(commandLine: CommandLine, cwd: string): AgentConfiguration {
  try {
    return readConfiguration({
      configFolder: configFolder(),
      cwd,
      permissionMode: commandLine.permissionMode,
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  } catch (error) {
    refuseToPlay(error);
  }
}

/** The files Claude Code keeps for a background task, by its id: under the temporary folder and the conversation's. */
function taskFilesOf(sessionId: string, cwd: string, transcriptPath: string) {
  return (agentId: string): TaskFiles => ({
    outputFile: join(
      tmpdir(),
      `claude-${userInfo().uid}`,
      projectFolderName(cwd),
      sessionId,
      'tasks',
      `${agentId}.output`,
    ),
    transcriptPath: join(dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.jsonl`),
  });
}

/** Says the version, as `claude --version` does, and exits. */
function sayVersion(): never {
  process.stdout.write(versionOutput(fakeAgentVersion(process.env)));
  process.exit(0);
}

/** Gives the agent the keys of its terminal, each byte as it is typed. */
function takeKeys(agent: FakeAgent): void {
  const decoder = createKeyDecoder();
  let settling: NodeJS.Timeout | undefined;
  const press = (keys: Key[]) => keys.forEach(agent.press);

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8').on('data', (chunk: string) => {
    clearTimeout(settling);
    press(decoder.decode(chunk));
    if (decoder.awaitsMore()) settling = setTimeout(() => press(decoder.settle()), ESCAPE_WAIT_MS);
  });
}

if (process.argv.slice(2).join(' ') === '--version') sayVersion();
const commandLine = readCommandLine();
const cwd = process.cwd();
const foundTranscript = transcriptPathOf(commandLine, cwd);
const transcriptPath =
  foundTranscript ?? transcriptPathFor(configFolder(), cwd, commandLine.sessionId);
const settings = settingsOf(commandLine);
const configuration = configurationOf(commandLine, cwd);
const session = {
  sessionId: commandLine.sessionId,
  cwd,
  transcriptPath,
  permissionMode: commandLine.permissionMode,
};
// Seen of Claude Code: the person's settings turning hooks off leave no hook at all.
const hooks = createHookRunner(configuration.hooksOff ? {} : settings.hooks, session);
if (foundTranscript === undefined) await leaveForAMissingConversation(hooks, configuration);
const agent = createFakeAgent({
  commandLine,
  hooks,
  transcript: openTranscript(transcriptPath, commandLine.sessionId),
  promptsTaken: countPrompts(transcriptPath),
  secondsSinceLastResponse: secondsSinceLastResponse(transcriptPath, new Date()),
  workFolder: cwd,
  historyIsOwn: historyIsOwn(commandLine, cwd),
  terminalSize,
  allowRules: settings.allowRules,
  deniedPaths: settings.deniedPaths,
  configuration,
  dialogSubjects: { folder: cwd, keySuffix: keySuffixOf(process.env.ANTHROPIC_API_KEY) },
  apiBaseUrl: process.env.ANTHROPIC_BASE_URL,
  taskFiles: taskFilesOf(commandLine.sessionId, cwd, transcriptPath),
  startReleased: () => startReleased(cwd),
  tasksReleased: () => tasksReleased(cwd),
  readScript: () => readScript(cwd),
  show,
  exit: (status) => process.exit(status),
});

takeKeys(agent);
process.on('SIGTERM', () => void agent.terminate());
void agent.start();
