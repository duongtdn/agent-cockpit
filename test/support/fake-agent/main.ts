import { readFileSync } from 'node:fs';
import { createFakeAgent, type FakeAgent } from './agent.ts';
import { type CommandLine, parseCommandLine } from './command-line.ts';
import { createHookRunner } from './hook-runner.ts';
import { type HookSettings, parseHookSettings } from './hook-settings.ts';
import { createKeyDecoder, type Key } from './keys.ts';
import { renderScreen, type ScreenView } from './screen.ts';
import { readScript } from './script.ts';
import { startReleased } from './start-gate.ts';
import { countPrompts, findTranscript, openTranscript, transcriptPathFor } from './transcript.ts';

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

/** Finds where the conversation is written: for a resumed one, where it already is. */
function transcriptPathOf(commandLine: CommandLine, cwd: string): string {
  if (!commandLine.resumes) return transcriptPathFor(configFolder(), cwd, commandLine.sessionId);
  return (
    findTranscript(configFolder(), commandLine.sessionId) ??
    refuse(`No conversation found with session ID: ${commandLine.sessionId}`)
  );
}

function hookSettingsOf(commandLine: CommandLine): HookSettings {
  if (commandLine.settingsFile === undefined) return {};
  return parseHookSettings(readFileSync(commandLine.settingsFile, 'utf8'));
}

function show(view: ScreenView): void {
  process.stdout.write(CLEAR_SCREEN + renderScreen(view).join('\r\n'));
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

const commandLine = readCommandLine();
const cwd = process.cwd();
const transcriptPath = transcriptPathOf(commandLine, cwd);
const session = {
  sessionId: commandLine.sessionId,
  cwd,
  transcriptPath,
  permissionMode: commandLine.permissionMode,
};
const agent = createFakeAgent({
  commandLine,
  hooks: createHookRunner(hookSettingsOf(commandLine), session),
  transcript: openTranscript(transcriptPath, commandLine.sessionId),
  promptsTaken: countPrompts(transcriptPath),
  startReleased: () => startReleased(cwd),
  readScript: () => readScript(cwd),
  show,
  exit: (status) => process.exit(status),
});

takeKeys(agent);
process.on('SIGTERM', () => void agent.terminate());
void agent.start();
