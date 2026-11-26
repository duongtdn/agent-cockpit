import { isAbsolute } from 'node:path';
import type { StartOptions } from './session-host.js';
import { SessionHostError } from './session-host-error.js';
import { CLIENT_TERMINAL_TYPE, checkedCells, checkedName } from './tmux-commands.js';

/** A tmux option of the host: where it is set (`-s` server, `-g` global), its name, its value. */
type HostSetting = readonly [scope: '-s' | '-g', option: string, value: string];

/**
 * The options the host sets on its server, for sessions shown in a terminal
 * embedded in a page. An option that is a list is set at an index of the
 * host's own: set again at every start, it must not grow.
 *
 * @param terminalType - The terminal type of the panes.
 */
function hostSettings(terminalType: string): readonly HostSetting[] {
  return [
    // Two terminals on one session share its window at the size of the one last used.
    ['-g', 'window-size', 'latest'],
    // The agent is told when its terminal gains or loses focus.
    ['-s', 'focus-events', 'on'],
    // A copy made by the program in the pane (OSC 52) reaches the attached terminal.
    ['-s', 'set-clipboard', 'on'],
    // What programs in a pane take their terminal for; tmux's default knows 8 colors.
    ['-s', 'default-terminal', terminalType],
    // 24-bit colors pass to the page's terminal as they are, not as the nearest of 256.
    ['-s', 'terminal-features[100]', `${CLIENT_TERMINAL_TYPE}:RGB`],
    // Esc reaches the agent at once: an interrupt must not wait half a second.
    ['-s', 'escape-time', '0'],
    // The wheel scrolls the session's history (copy-mode), not the agent's input.
    ['-g', 'mouse', 'on'],
    // Ctrl+B is the agent's key, like every other: the page gives no tmux commands.
    ['-g', 'prefix', 'None'],
    ['-g', 'prefix2', 'None'],
    // The page shows the agent's screen, every row of it, and no status line of tmux.
    ['-g', 'status', 'off'],
  ];
}

/**
 * Quotes a word for a tmux command file. Nothing is special between single
 * quotes, with one exception: tmux reads the file line by line first, and
 * takes a line that begins with `#` for a comment even inside quotes. So a
 * line break leaves the quotes and is written as its escape.
 */
function quoted(word: string): string {
  if (word.includes('\0')) {
    throw new TypeError('No command, argument, folder or value holds a NUL character.');
  }
  return word
    .split('\n')
    .map((line) => `'${line.replaceAll("'", "'\\''")}'`)
    .join('"\\n"');
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkedVariableName(name: string): string {
  if (!VARIABLE_NAME.test(name)) {
    throw new TypeError(`Not the name of an environment variable: ${JSON.stringify(name)}`);
  }
  return name;
}

/** tmux falls back to the home folder for one it cannot use; a relative one has no base. */
function checkedFolder(folder: string): string {
  if (!isAbsolute(folder)) {
    throw new TypeError(`A session's folder is an absolute path: ${JSON.stringify(folder)}`);
  }
  return folder;
}

/**
 * Keeps tmux from reading a word as a format: `#{…}` would be replaced and
 * `#(…)` run as a shell command. Of the words the host writes, tmux expands
 * the folder alone: a session's name and its targets hold no `#` (their
 * characters are checked), a variable's value, the command and its
 * arguments are taken as they are, and the formats and options are the
 * host's own.
 */
function formatEscaped(word: string): string {
  return word.replaceAll('#', '##');
}

/** env would read a word with `=` as a variable to set, not as the program to run. */
function checkedCommand(command: string): string {
  if (command === '' || command.includes('=')) {
    throw new TypeError(`Not a command the host can run: ${JSON.stringify(command)}`);
  }
  return command;
}

/**
 * The most bytes of one word a program is executed with: Linux refuses an
 * argument, or a variable with its name, of 128 KiB counted with the NUL
 * that ends it, however small the rest. tmux tells no one that it could not
 * execute a command: the session is created, then gone. So the host refuses
 * such a word itself, on every system alike.
 */
const MOST_WORD_BYTES = 128 * 1024 - 1;

/**
 * Checks that a word is short enough to execute a program with.
 *
 * @param what - What the word is, for the error's message: never its value,
 * which may be a secret.
 * @throws `SessionHostError` `host-failed` when it is not.
 */
function checkedLength(word: string, what: string): string {
  const bytes = Buffer.byteLength(word);
  if (bytes > MOST_WORD_BYTES) {
    throw new SessionHostError(
      'host-failed',
      `No system executes a command with the ${what}: ${bytes} bytes, of ${MOST_WORD_BYTES} at most.`,
    );
  }
  return word;
}

/**
 * The variable that tells a program its terminal shows 24-bit colors, and
 * the value that says so. The host passes those colors on to the page's
 * terminal, so every session has it. tmux sets it for a pane itself, to
 * this value, from 3.6 on; on an older tmux the host gives it.
 */
const COLOR_HINT = { name: 'COLORTERM', value: 'truecolor' } as const;

/**
 * The variables a pane has of its own, over whatever a session is started
 * with. tmux sets (seen on 3.2a) `TERM` (the `default-terminal` option),
 * `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TMUX`, `TMUX_PANE`, and `SHELL`
 * (the server's `default-shell`); the color hint is tmux's from 3.6 on and
 * the host's before.
 */
const PANE_VARIABLES: ReadonlySet<string> = new Set([
  'TERM',
  COLOR_HINT.name,
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMUX',
  'TMUX_PANE',
  'SHELL',
]);

/** tmux gives a pane that would have no `PATH` one of its own. */
const GIVEN_WHEN_ABSENT = 'PATH';

/** What a start is written from, beyond its options. */
export interface StartContext {
  /** The environment of the calling process: the one the session gets. */
  readonly processEnvironment: Readonly<Record<string, string | undefined>>;
  /** The names of the variables the tmux server would give a session by itself. */
  readonly serverVariables: readonly string[];
  /** The terminal type of the server's panes. */
  readonly terminalType: string;
}

/**
 * The variables of a session's process, tmux's own aside: those of the
 * calling process, with the session's folder for working directory, then the
 * ones set, then the color hint, without the ones removed.
 */
function sessionVariables(options: StartOptions, context: StartContext): Map<string, string> {
  const variables = new Map<string, string>();
  for (const [name, value] of Object.entries(context.processEnvironment)) {
    if (value !== undefined && !PANE_VARIABLES.has(name)) variables.set(name, value);
  }
  // The calling process's own working directories are not the session's.
  variables.delete('OLDPWD');
  variables.set('PWD', options.folder);
  for (const [name, value] of Object.entries(options.environment.set)) {
    variables.set(checkedVariableName(name), value);
  }
  // Given on every tmux alike: one older than 3.6 does not set it itself.
  variables.set(COLOR_HINT.name, COLOR_HINT.value);
  for (const name of options.environment.remove) variables.delete(checkedVariableName(name));
  return variables;
}

/**
 * The names `env` removes: what the server would add by itself to the
 * session's variables, and what the session must not see.
 */
function removedNames(
  options: StartOptions,
  context: StartContext,
  variables: ReadonlyMap<string, string>,
): Set<string> {
  const added = [...context.serverVariables, GIVEN_WHEN_ABSENT].filter(
    (name) => !variables.has(name) && !PANE_VARIABLES.has(name),
  );
  return new Set([...added, ...options.environment.remove]);
}

/**
 * The command's words. It runs behind `env`, for two reasons: `env` removes
 * variables for this session alone, which tmux cannot do at a start; and
 * tmux hands a command of one word to a shell, which `env` in front makes
 * impossible. `env` replaces itself with the command, so the pane's process
 * is the command. `--` ends the options of `env` (GNU's and BSD's alike): a
 * command may begin with a hyphen.
 */
function commandWords(options: StartOptions, removed: ReadonlySet<string>): string[] {
  const removals = Array.from(removed, (name) => ['-u', name]).flat();
  const command = checkedLength(checkedCommand(options.command), 'command');
  const args = options.args.map((arg, index) => checkedLength(arg, `argument ${index + 1}`));
  return ['/usr/bin/env', ...removals, '--', command, ...args];
}

/**
 * Writes the tmux commands that start a session: the host's options, then
 * the session, detached, with its name, size, folder, variables and command.
 *
 * The session's process gets the environment of the calling process, with
 * the folder as `PWD` and no `OLDPWD`, plus the variables set, minus the
 * ones removed — whatever the tmux server's own environment holds: every
 * variable is given to the session, and `env` removes what the server alone
 * has. Only `TERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TMUX`,
 * `TMUX_PANE` and `SHELL` are tmux's to set, whatever is set here, and
 * `COLORTERM` is `truecolor` (tmux's own from 3.6 on, the host's before);
 * a name removed is removed among them too. Values are written in these commands
 * only, never in a process's arguments; names are.
 *
 * @param options - What the session is started with.
 * @param context - The calling process's environment, the names of the
 * server's variables and the panes' terminal type.
 * @returns The commands, one per line, for tmux's `source-file`.
 * @throws `TypeError` or `RangeError` for a name, a folder, a variable
 * name, a command or a size that cannot be used, and for a NUL character;
 * `SessionHostError` `host-failed` for a command, an argument or a variable
 * too long for a system to execute a program with (128 KiB).
 */
export function startScript(options: StartOptions, context: StartContext): string {
  const { name, folder, size } = options;
  const variables = sessionVariables(options, context);
  const settings = hostSettings(context.terminalType).map(
    ([scope, option, value]) => `set-option ${scope} ${quoted(option)} ${quoted(value)}`,
  );
  const session = [
    'new-session',
    '-d',
    '-s',
    quoted(checkedName(name)),
    '-x',
    checkedCells(size.columns, 'columns'),
    '-y',
    checkedCells(size.rows, 'rows'),
    '-c',
    quoted(formatEscaped(checkedFolder(folder))),
    ...Array.from(variables, ([variable, value]) => [
      '-e',
      quoted(checkedLength(`${variable}=${value}`, `variable ${variable}`)),
    ]).flat(),
    '--',
    ...commandWords(options, removedNames(options, context, variables)).map(quoted),
  ];
  return [...settings, session.join(' '), ''].join('\n');
}
