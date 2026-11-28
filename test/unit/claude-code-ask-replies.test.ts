import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/claude-code.ts';
import type { AskOfCall } from '../../src/server/driver.ts';
import type { AskAnswer } from '../../src/shared/ask.ts';
import { recordedPayload, SAMPLE_VALUES } from '../support/recorded-hooks.ts';

// Every ask starts from a PermissionRequest the pinned Claude Code sent, as the contract suite
// recorded it; a test changes the tool's name or input only to try a value of its own.
const driver = claudeCode();
const { cwd } = SAMPLE_VALUES;

/**
 * The ask of a recorded PermissionRequest of a tool, its input's fields changed as given; for
 * another tool, its input is the one given alone.
 */
function askOf(
  recordedTool: 'Bash' | 'Read' | 'Write',
  change: { tool?: string; input?: Record<string, unknown> } = {},
): AskOfCall {
  const payload = recordedPayload(
    'PermissionRequest',
    (each) => each.tool_name === recordedTool && !('agent_id' in each),
  );
  const recordedInput =
    change.tool === undefined ? (payload.tool_input as Record<string, unknown>) : {};
  const input = { ...recordedInput, ...change.input };
  return {
    ref: 'call-1',
    content: { kind: 'permission', tool: change.tool ?? recordedTool, input },
  };
}

const bash = (command: unknown) => askOf('Bash', { input: { command } });
const fileTool = (tool: string, filePath: unknown) =>
  askOf('Write', { tool, input: { file_path: filePath } });

/** The decision the agent reads from the PermissionRequest hook's reply. */
function decision(behavior: 'allow' | 'deny', fields: Record<string, unknown> = {}) {
  return {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...fields } },
  };
}

const ALLOW = decision('allow');
const REMEMBER: AskAnswer = { allow: true, remember: 'session' };

/** An `allow` that adds this one rule for the rest of the session. */
function allowRemembering(rule: { toolName: string; ruleContent?: string }) {
  return decision('allow', {
    updatedPermissions: [
      { type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' },
    ],
  });
}

describe("Claude Code's reply to a permission's answer", () => {
  it('allows the call once', () => {
    expect(driver.answerReply(bash('touch asked.txt'), { allow: true })).toEqual(ALLOW);
  });

  it('denies with the message, which the agent gives the model', () => {
    expect(
      driver.answerReply(bash('touch asked.txt'), { allow: false, message: 'Not that file.' }),
    ).toEqual(decision('deny', { message: 'Not that file.' }));
  });

  it('denies bare without a message: the agent then tells the model "Permission denied by hook"', () => {
    expect(driver.answerReply(bash('touch asked.txt'), { allow: false })).toEqual(decision('deny'));
  });
});

describe('what "remember" adds for a Bash command', () => {
  it.each([
    ['the recorded one', 'touch asked.txt'],
    ['a program alone', 'ls'],
    ['one with a dot, a dash and an underscore in its name', 'my_tool-2.sh --check'],
    ['one led by spaces, kept as the agent sent it', '  git status'],
    ['one naming a variable', 'echo $HOME'],
    ['a shell running a command line', "bash -c 'rm -rf build'"],
    ['a shell alone', 'sh'],
    ['env', 'env FOO=1 make'],
    ['sudo', 'sudo ls'],
    ['xargs', 'xargs rm'],
    ['nohup', 'nohup npm start'],
    ['timeout', 'timeout 5 make'],
    ['an interpreter running code', 'python3 -c pass'],
    ['node running code', 'node -e 1'],
    ['npx', 'npx prettier --write .'],
    ['find running a command', 'find . -name x -exec rm'],
    ['git with a setting', 'git -c core.pager=less log'],
    ['two commands joined by &&', 'cd build && rm -rf dist'],
    ['two commands joined by ;', 'rm d2; touch e'],
    ['a pipe', 'cat notes.txt | wc -l'],
    ['a command in the background', 'npm start &'],
    ['a redirection out', 'echo hi > out.txt'],
    ['a redirection in', 'wc -l < in.txt'],
    ['a command in backquotes', 'echo `whoami`'],
    ['an assignment first', 'FOO=1 make'],
    ['a path first', './run.sh'],
    ['an absolute path first', '/usr/bin/env node'],
    ['a quoted program first', '"$X" go'],
    ['a quote around a plain word first', "'ls' -la"],
  ])('remembers that exact command, whatever its first word, never a prefix: %s', (_, command) => {
    expect(driver.answerReply(bash(command), REMEMBER)).toEqual(
      allowRemembering({ toolName: 'Bash', ruleContent: command }),
    );
  });

  it.each([
    ['a glob', 'ls *.txt'],
    ['a question mark', 'ls file?.txt'],
    ['brackets', 'ls [ab].txt'],
    ['braces', 'touch {a,b}.txt'],
    ['a subshell', '(cd build && make)'],
    ['a command substitution', 'echo $(whoami)'],
    ['a backslash', 'echo a\\ b'],
    ['a line break between two commands', 'touch a\nrm b'],
    ['a tab', 'echo\tx'],
  ])(
    'allows once, adding no rule, a command holding a character a rule reads as its own: %s',
    (_, command) => {
      expect(driver.answerReply(bash(command), REMEMBER)).toEqual(ALLOW);
    },
  );

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['missing', undefined],
    ['not a string', ['touch', 'a']],
  ])(
    'allows once, adding no rule, a command it cannot spell, which could read as every command: %s',
    (_, command) => {
      expect(driver.answerReply(bash(command), REMEMBER)).toEqual(ALLOW);
    },
  );
});

describe('what "remember" adds for a file tool', () => {
  it.each([
    ['Write', 'Edit'],
    ['Edit', 'Edit'],
    ['Read', 'Read'],
  ])('remembers a %s as a rule of %s on the absolute path, spelled with //', (tool, ruleTool) => {
    const path = `${cwd}/written.txt`;
    expect(driver.answerReply(fileTool(tool, path), REMEMBER)).toEqual(
      allowRemembering({ toolName: ruleTool, ruleContent: `/${path}` }),
    );
  });

  it('remembers the recorded Read outside the working folder as a rule on that file alone', () => {
    const ask = askOf('Read');
    expect(driver.answerReply(ask, REMEMBER)).toEqual(
      allowRemembering({ toolName: 'Read', ruleContent: `/${SAMPLE_VALUES.root}/outside/r3.txt` }),
    );
  });

  it.each([
    ['a glob', `${cwd}/*.txt`],
    ['brackets', `${cwd}/[draft].md`],
    ['parentheses', `${cwd}/notes (1).txt`],
    ['braces', `${cwd}/{a}.txt`],
    ['a question mark', `${cwd}/why?.txt`],
    ['a backslash', `${cwd}/a\\b.txt`],
    ['a line break', `${cwd}/a\nb.txt`],
  ])(
    'allows once, adding no rule, a path holding a character a rule reads as its own: %s',
    (_, path) => {
      expect(driver.answerReply(fileTool('Edit', path), REMEMBER)).toEqual(ALLOW);
    },
  );

  it.each([
    ['relative to the working folder', 'written.txt'],
    ['relative, above it', '../outside/o.txt'],
    ['from the home folder', '~/notes.txt'],
    ['absolute but not normal: a parent step', `${cwd}/../outside/o.txt`],
    ['absolute but not normal: a doubled slash', `${cwd}//written.txt`],
    ['absolute but not normal: a trailing slash', `${cwd}/folder/`],
    ['empty', ''],
    ['missing', undefined],
  ])('allows once, adding no rule, a path that is not one normal absolute path: %s', (_, path) => {
    expect(driver.answerReply(fileTool('Read', path), REMEMBER)).toEqual(ALLOW);
  });

  it.each([
    ['NotebookEdit', { notebook_path: `${cwd}/n.ipynb`, new_source: 'x' }],
    ['MultiEdit', { file_path: `${cwd}/written.txt`, edits: [] }],
    ['Grep', { pattern: 'x', path: `${SAMPLE_VALUES.root}/outside` }],
    ['LS', { path: `${SAMPLE_VALUES.root}/outside` }],
  ])(
    'allows once, adding no rule, another tool on a file (%s): no rule of it is known to hold',
    (tool, input) => {
      expect(driver.answerReply(askOf('Write', { tool, input }), REMEMBER)).toEqual(ALLOW);
    },
  );

  it.each([
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: `${SAMPLE_VALUES.root}/outside/**` }],
  ])(
    'allows once, adding no rule, a %s that names no path: its name alone would reach every file',
    (tool, input) => {
      expect(driver.answerReply(askOf('Write', { tool, input }), REMEMBER)).toEqual(ALLOW);
    },
  );

  it.each([
    ['a path', 'mcp__files__list', { path: `${SAMPLE_VALUES.root}/outside` }],
    ['a local file', 'mcp__docs__upload', { local_path: `${cwd}/doc.md` }],
  ])(
    'allows once, adding no rule, a tool not known to work on files whose input names %s',
    (_, tool, input) => {
      expect(driver.answerReply(askOf('Write', { tool, input }), REMEMBER)).toEqual(ALLOW);
    },
  );
});

describe('what "remember" adds for any other tool', () => {
  it('remembers the tool by its name alone', () => {
    const ask = askOf('Bash', {
      tool: 'WebFetch',
      input: { url: 'http://localhost/', prompt: 'read it' },
    });
    expect(driver.answerReply(ask, REMEMBER)).toEqual(allowRemembering({ toolName: 'WebFetch' }));
  });

  it("remembers an MCP server's tool by its name alone", () => {
    const ask = askOf('Bash', { tool: 'mcp__notes__save', input: { text: 'x' } });
    expect(driver.answerReply(ask, REMEMBER)).toEqual(
      allowRemembering({ toolName: 'mcp__notes__save' }),
    );
  });

  it('allows once, adding no rule, a tool whose name holds a character a rule reads as its own', () => {
    const ask = askOf('Bash', { tool: 'mcp__odd__name(x)', input: {} });
    expect(driver.answerReply(ask, REMEMBER)).toEqual(ALLOW);
  });
});

describe("how Claude Code's driver stops a turn waiting on an ask", () => {
  it('answers the oldest ask the app can answer with a deny that interrupts, no message: the agent would show it nowhere', () => {
    expect(driver.interrupting.appAsk.reply).toEqual(decision('deny', { interrupt: true }));
  });

  it('presses one Esc for an ask answerable only in the terminal, as for a busy turn', () => {
    expect(driver.interrupting.terminalAsk).toEqual({ keys: ['Escape'] });
    expect(driver.interrupting.terminalAsk).toEqual(driver.interrupting.busy);
  });
});
