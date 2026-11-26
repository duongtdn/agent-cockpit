import { describe, expect, it } from 'vitest';
import type { StartOptions } from '../../src/server/session-host/session-host.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import { type StartContext, startScript } from '../../src/server/session-host/tmux-start.ts';

const start: StartOptions = {
  name: 'chapter-1',
  folder: '/srv/app',
  command: 'agent',
  args: [],
  environment: { set: {}, remove: [] },
  size: { columns: 120, rows: 40 },
};

const context: StartContext = {
  processEnvironment: {},
  serverVariables: [],
  hiddenVariables: [],
  terminalType: 'tmux-256color',
};

/** The script's last command: the one that starts the session. */
function sessionCommand(options: StartOptions, known: Partial<StartContext> = {}): string {
  return (
    startScript(options, { ...context, ...known })
      .split('\n')
      .at(-2) ?? ''
  );
}

describe('the commands that start a session', () => {
  it('refuse a folder that is no absolute path', () => {
    expect(() => startScript({ ...start, folder: 'srv/app' }, context)).toThrow(TypeError);
  });

  it('set the host’s options first, then start the session, one command a line', () => {
    const commands = startScript(start, context).split('\n');

    expect(commands.at(-1)).toBe('');
    expect(commands.at(-2)).toMatch(/^new-session /);
    expect(commands.length).toBeGreaterThan(2);
    for (const setting of commands.slice(0, -2)) {
      expect(setting).toMatch(/^set-option -[sg] '[^' ]+' '[^']+'$/);
    }
  });

  it('start the session detached, with its name, size and folder, its command behind env', () => {
    const command = sessionCommand(start);

    expect(command).toMatch(/^new-session -d -s 'chapter-1' -x 120 -y 40 -c '\/srv\/app' -e /);
    expect(command).toMatch(/ -- '\/usr\/bin\/env' '-u' 'PATH' '--' 'agent'$/);
  });

  it('write as many lines whatever the values, the arguments and the folder hold', () => {
    const plain = startScript(start, context).split('\n');

    const odd = startScript(
      {
        ...start,
        folder: '/srv/two\nlines',
        args: ['two\n#lines', "it's\n"],
        environment: { set: { A: '\n\n', B: 'new-session\nkill-server' }, remove: [] },
      },
      context,
    ).split('\n');

    expect(odd).toHaveLength(plain.length);
  });

  it('give the panes the terminal type the machine knows', () => {
    expect(startScript(start, { ...context, terminalType: 'screen-256color' })).toContain(
      "set-option -s 'default-terminal' 'screen-256color'\n",
    );
  });

  it('pass each argument as one quoted word, whatever it holds', () => {
    const command = sessionCommand({
      ...start,
      args: ['--flag', 'a;', '$HOME', "it's", 'two\nlines', '', '#{pane_pid}', 'back\\'],
    });

    expect(command).toContain(
      `'--' 'agent' '--flag' 'a;' '$HOME' 'it'\\''s' 'two'"\\n"'lines' '' '#{pane_pid}' 'back\\'`,
    );
  });

  it.each([
    ['/srv/x#(touch f)', "'/srv/x##(touch f)'"],
    ['/srv/#{pane_pid}', "'/srv/##{pane_pid}'"],
    ['/srv/a##b', "'/srv/a####b'"],
    ['/srv/it\'s a ~ $HOME; "q"', `'/srv/it'\\''s a ~ $HOME; "q"'`],
    ['/srv/é漢😀', "'/srv/é漢😀'"],
  ])('keep tmux from reading the folder %j as a format', (folder, written) => {
    expect(sessionCommand({ ...start, folder })).toContain(` -c ${written} -e `);
  });

  it('end env’s options before the command, which may begin with a hyphen', () => {
    expect(sessionCommand({ ...start, command: '-tool', args: ['-u'] })).toMatch(
      / '--' '-tool' '-u'$/,
    );
  });

  describe('give the session the environment of the calling process', () => {
    it('with every variable of the process, the folder as PWD, then the ones set', () => {
      const command = sessionCommand(
        {
          ...start,
          environment: { set: { TOKEN: "a b;'c'", EMPTY: '', HOME: '/other' }, remove: [] },
        },
        {
          processEnvironment: {
            HOME: '/home/me',
            'odd.name': '1',
            NONE: undefined,
            PWD: '/',
            OLDPWD: '/old',
          },
        },
      );

      expect(command).toContain(
        " -c '/srv/app' -e 'HOME=/other' -e 'odd.name=1' -e 'PWD=/srv/app' -e 'TOKEN=a b;'\\''c'\\''' -e 'EMPTY=' -e 'COLORTERM=truecolor' -- ",
      );
    });

    it('writes a value as it is, whatever it holds', () => {
      const command = sessionCommand(start, {
        processEnvironment: { A: 'two\n#lines', B: '#{pid}#(id)', C: '=a=', D: '$HOME ~' },
      });

      expect(command).toContain(
        ` -e 'A=two'"\\n"'#lines' -e 'B=#{pid}#(id)' -e 'C==a=' -e 'D=$HOME ~' `,
      );
    });

    it('without the variables tmux sets for a pane itself', () => {
      const command = sessionCommand(start, {
        processEnvironment: {
          TERM: 'xterm',
          TERM_PROGRAM: 'vscode',
          TERM_PROGRAM_VERSION: '1',
          COLORTERM: '24bit',
          TMUX: '/tmp/tmux-1/default,1,0',
          TMUX_PANE: '%0',
          SHELL: '/bin/zsh',
          KEPT: '1',
        },
        serverVariables: ['TERM', 'SHELL', 'TMUX'],
      });

      expect(command).toContain(
        " -e 'KEPT=1' -e 'PWD=/srv/app' -e 'COLORTERM=truecolor' -- '/usr/bin/env' '-u' 'PATH' '--' ",
      );
    });

    it('with COLORTERM=truecolor, whatever the process has and whatever is set', () => {
      const command = sessionCommand(
        { ...start, environment: { set: { COLORTERM: '24bit', SET: '1' }, remove: [] } },
        { processEnvironment: { COLORTERM: 'other' }, serverVariables: ['COLORTERM'] },
      );

      expect(command).toContain(
        " -c '/srv/app' -e 'PWD=/srv/app' -e 'COLORTERM=truecolor' -e 'SET=1' -- '/usr/bin/env' '-u' 'PATH' '--' ",
      );
    });

    it('without COLORTERM when it is removed, as for the variables tmux sets', () => {
      const command = sessionCommand(
        { ...start, environment: { set: {}, remove: ['COLORTERM'] } },
        { processEnvironment: { COLORTERM: 'other' } },
      );

      expect(command).toContain(
        " -c '/srv/app' -e 'PWD=/srv/app' -- '/usr/bin/env' '-u' 'PATH' '-u' 'COLORTERM' '--' ",
      );
    });

    it('with env removing what the server alone has, and what is named', () => {
      const command = sessionCommand(
        { ...start, environment: { set: { SET: '1' }, remove: ['HOME', 'NOT_SET', 'TERM'] } },
        {
          processEnvironment: { HOME: '/home/me', PATH: '/bin', LANG: 'C' },
          serverVariables: ['STALE', 'LANG', 'odd name', 'SET', 'HOME', 'STALE'],
        },
      );

      expect(command).toContain(
        " -e 'PATH=/bin' -e 'LANG=C' -e 'PWD=/srv/app' -e 'SET=1' -e 'COLORTERM=truecolor' -- '/usr/bin/env' '-u' 'STALE' '-u' 'odd name' '-u' 'HOME' '-u' 'NOT_SET' '-u' 'TERM' '--' 'agent'",
      );
    });
  });

  it.each(['', 'A=B', 'a b', '1A', 'A-B'])('refuse the variable name %j', (name) => {
    expect(() =>
      startScript({ ...start, environment: { set: { [name]: 'x' }, remove: [] } }, context),
    ).toThrow(TypeError);
    expect(() =>
      startScript({ ...start, environment: { set: {}, remove: [name] } }, context),
    ).toThrow(TypeError);
  });

  it('give each variable one word, its name and its value', () => {
    const command = sessionCommand(start, { processEnvironment: { A: '1', B: '2' } });

    expect(command.match(/ -e '/g)).toHaveLength(4);
    expect(command).toContain(" -e 'A=1' -e 'B=2' -e 'PWD=/srv/app' -e 'COLORTERM=truecolor' -- ");
  });

  it.each(['', 'a.b', 'a:b', 'a b', '=a', 'a*', 'a\nb', 'é'])('refuse the name %j', (name) => {
    expect(() => startScript({ ...start, name }, context)).toThrow(TypeError);
  });

  it.each(['', 'a=b', './x=y'])('refuse the command %j, which env would not run', (command) => {
    expect(() => startScript({ ...start, command }, context)).toThrow(TypeError);
  });

  it.each([
    ['the command', { command: 'a\0b' }],
    ['an argument', { args: ['a\0b'] }],
    ['the folder', { folder: '/a\0b' }],
    ['a value', { environment: { set: { A: 'a\0b' }, remove: [] } }],
  ])('refuse a NUL character in %s', (_where, changed) => {
    expect(() => startScript({ ...start, ...changed }, context)).toThrow(TypeError);
  });

  it.each([
    { columns: 0, rows: 40 },
    { columns: 120, rows: 0 },
    { columns: 80.5, rows: 24 },
    { columns: Number.NaN, rows: 24 },
  ])('refuse the size %j', (size) => {
    expect(() => startScript({ ...start, size }, context)).toThrow(RangeError);
  });

  describe('refuse what no system would execute: a word of 128 KiB with the NUL that ends it', () => {
    const MOST_BYTES = 128 * 1024 - 1;

    function failureOf(options: StartOptions, known: Partial<StartContext> = {}): unknown {
      try {
        startScript(options, { ...context, ...known });
        return undefined;
      } catch (error) {
        return error;
      }
    }

    it('take the longest argument, variable and command a system executes', () => {
      const options = {
        ...start,
        command: `/${'c'.repeat(MOST_BYTES - 1)}`,
        args: ['a'.repeat(MOST_BYTES)],
        environment: { set: { SET: 's'.repeat(MOST_BYTES - 'SET='.length) }, remove: [] },
      };
      const processEnvironment = { OWN: 'o'.repeat(MOST_BYTES - 'OWN='.length) };

      expect(failureOf(options, { processEnvironment })).toBeUndefined();
    });

    it.each([
      ['an argument', { args: ['fits', 'a'.repeat(MOST_BYTES + 1)] }, 'argument 2'],
      ['an argument, counted in bytes', { args: ['é'.repeat(MOST_BYTES / 2 + 1)] }, 'argument 1'],
      ['the command', { command: 'c'.repeat(MOST_BYTES + 1) }, 'command'],
      [
        'a variable set, with its name',
        { environment: { set: { SET: 's'.repeat(MOST_BYTES - 'SET='.length + 1) }, remove: [] } },
        'variable SET',
      ],
    ])('fail as the host’s own failure for %s one byte longer', (_what, changed, named) => {
      const error = failureOf({ ...start, ...changed });

      expect(error).toBeInstanceOf(SessionHostError);
      expect(error).toMatchObject({ reason: 'host-failed' });
      expect((error as Error).message).toContain(named);
    });

    it('fail for a variable of the calling process too, unless the session has it removed', () => {
      const processEnvironment = { OWN: 'o'.repeat(MOST_BYTES) };

      const error = failureOf(start, { processEnvironment });

      expect(error).toMatchObject({ reason: 'host-failed' });
      expect((error as Error).message).toContain('variable OWN');
      expect(
        failureOf({ ...start, environment: { set: {}, remove: ['OWN'] } }, { processEnvironment }),
      ).toBeUndefined();
    });

    it('never tell the value, which may be a secret', () => {
      const error = failureOf({
        ...start,
        environment: { set: { TOKEN: 'secret'.repeat(MOST_BYTES) }, remove: [] },
      });

      expect((error as Error).message).not.toContain('secret');
    });
  });
});
