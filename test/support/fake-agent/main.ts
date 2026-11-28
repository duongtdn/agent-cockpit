import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { recordedPayload } from '../recorded-hooks.ts';
import { CANNOT_PLAY_STATUS, createFakeAgent } from './agent.ts';
import { type CommandLine, parseCommandLine } from './command-line.ts';
import { createHookRunner } from './hook-runner.ts';
import { type HookSettings, parseHookSettings } from './hook-settings.ts';
import {
  readScript,
  type Step,
  type TerminalAnswer,
  takeRelease,
  takeTerminalAnswer,
} from './script.ts';
import { openTranscript, transcriptPathFor } from './transcript.ts';
import { fakeAgentVersion, versionOutput } from './version.ts';

/** How often a held agent looks whether the test released it or answered its ask, in milliseconds. */
const RELEASE_CHECK_MS = 10;

/** Ends the process at once, saying why, as a program that cannot start does. */
function refuse(message: string): never {
  process.stderr.write(`fake agent: ${message}\n`);
  process.exit(1);
}

/** Ends the process at once on what it does not play, saying why. */
function cannotPlay(error: unknown): never {
  process.stderr.write(`fake agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(CANNOT_PLAY_STATUS);
}

function readCommandLine(): CommandLine {
  try {
    return parseCommandLine(process.argv.slice(2));
  } catch (error) {
    refuse((error as Error).message);
  }
}

/**
 * The configuration folder is where the transcripts go. Without one of the
 * test's, the fake agent would write into the person's own.
 */
function configFolder(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ??
    refuse('CLAUDE_CONFIG_DIR is not set, and it writes only where a test tells it to')
  );
}

function hookSettingsOf(commandLine: CommandLine): HookSettings {
  if (commandLine.settingsFile === undefined) return {};
  try {
    return parseHookSettings(readFileSync(commandLine.settingsFile, 'utf8'));
  } catch (error) {
    cannotPlay(error);
  }
}

function scriptOf(cwd: string, prompt: string | undefined): Step[] {
  try {
    return readScript(cwd, prompt);
  } catch (error) {
    cannotPlay(error);
  }
}

async function released(cwd: string): Promise<void> {
  while (!takeRelease(cwd)) await pause(RELEASE_CHECK_MS);
}

async function answeredInTerminal(cwd: string, signal: AbortSignal): Promise<TerminalAnswer> {
  for (;;) {
    const answer = takeTerminalAnswer(cwd);
    if (answer !== undefined) return answer;
    await pause(RELEASE_CHECK_MS, undefined, { signal });
  }
}

if (process.argv.slice(2).join(' ') === '--version') {
  process.stdout.write(versionOutput(fakeAgentVersion(process.env)));
  process.exit(0);
}
const commandLine = readCommandLine();
const config = configFolder();
// Only a new conversation is played: what Claude Code does on --resume is the contract suite's.
if (commandLine.resumes) cannotPlay(new Error('--resume: it plays a new conversation only'));
const cwd = process.cwd();
const { sessionId, prompt } = commandLine;
const transcriptPath = transcriptPathFor(config, cwd, sessionId);
if (existsSync(transcriptPath)) cannotPlay(new Error(`the conversation ${sessionId} exists`));
const values = { sessionId, transcriptPath, cwd, root: dirname(cwd) };
const agent = createFakeAgent({
  prompt,
  steps: scriptOf(cwd, prompt),
  hooks: createHookRunner(hookSettingsOf(commandLine), cwd),
  recorded: (event, where) => recordedPayload(event, where, values),
  transcript: openTranscript(transcriptPath, sessionId),
  released: () => released(cwd),
  answeredInTerminal: (signal) => answeredInTerminal(cwd, signal),
  exit: (status) => process.exit(status),
});

// It takes no key and draws nothing: it lives until its script ends it, a signal or its terminal's end.
setInterval(() => {}, 2 ** 31 - 1);
process.on('SIGTERM', () => void agent.terminate().catch(cannotPlay));
agent.start().catch(cannotPlay);
