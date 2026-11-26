/** What the fake agent reads from the command line Claude Code is launched with. */
export interface CommandLine {
  /** The conversation's id, from `--session-id` or `--resume`. */
  readonly sessionId: string;
  /** Whether the id came with `--resume`: the conversation exists and goes on. */
  readonly resumes: boolean;
  /** The file given with `--settings`, where the hooks are. */
  readonly settingsFile: string | undefined;
  /** The mode given with `--permission-mode`, or `default`. */
  readonly permissionMode: string;
  /** The model given with `--model`, as it was written; none when the launch names none. */
  readonly model: string | undefined;
  /** The prompt that follows `--`: submitted with no keys. */
  readonly prompt: string | undefined;
}

/**
 * How many values each option of a launch takes. An option of several values
 * reads every word up to the next option, which is why a prompt needs `--`.
 */
const OPTION_VALUES: Readonly<Record<string, 'none' | 'one' | 'several'>> = {
  '--session-id': 'one',
  '--resume': 'one',
  '--settings': 'one',
  '--permission-mode': 'one',
  '--model': 'one',
  '--plugin-dir': 'one',
  '--setting-sources': 'one',
  '--mcp-config': 'several',
  '--strict-mcp-config': 'none',
};

const PROMPT_SEPARATOR = '--';

/**
 * Reads the arguments of a launch as Claude Code would.
 *
 * @param args - The arguments after the program's name.
 * @returns What the fake agent plays from them; the other options of a launch are accepted and unused.
 * @throws `Error` for an option no launch uses, an option without its value,
 * a launch that names no session, a word that belongs to no option, and more
 * than one prompt.
 */
export function parseCommandLine(args: readonly string[]): CommandLine {
  const separator = args.indexOf(PROMPT_SEPARATOR);
  const options = readOptions(separator === -1 ? args : args.slice(0, separator));
  const prompts = separator === -1 ? [] : args.slice(separator + 1);
  if (prompts.length > 1) throw new Error('one prompt at most follows --');

  const sessionId = options.get('--session-id') ?? options.get('--resume');
  if (sessionId === undefined) throw new Error('one of --session-id and --resume is needed');
  return {
    sessionId,
    resumes: options.has('--resume'),
    settingsFile: options.get('--settings'),
    permissionMode: options.get('--permission-mode') ?? 'default',
    model: options.get('--model'),
    prompt: prompts[0],
  };
}

/** Reads the options before the prompt: each with its value, the last one for an option of several. */
function readOptions(words: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  let index = 0;
  while (index < words.length) {
    const option = words[index] as string;
    const values = valuesOf(option, words, index + 1);
    options.set(option, values.at(-1) ?? '');
    index += 1 + values.length;
  }
  return options;
}

function valuesOf(option: string, words: readonly string[], from: number): readonly string[] {
  const count = OPTION_VALUES[option];
  if (count === undefined) throw new Error(`unknown option ${option}`);
  if (count === 'none') return [];
  if (count === 'several') return wordsUpToNextOption(words, from);
  const value = words[from];
  if (value === undefined) throw new Error(`${option} needs a value`);
  return [value];
}

function wordsUpToNextOption(words: readonly string[], from: number): readonly string[] {
  const next = words.findIndex((word, index) => index >= from && word.startsWith('--'));
  return words.slice(from, next === -1 ? words.length : next);
}
