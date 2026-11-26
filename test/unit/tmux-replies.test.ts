import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  parseLines,
  parseProcess,
  parseScreen,
  parseServer,
  parseVariableNames,
  socketLeftBehind,
} from '../../src/server/session-host/tmux-replies.ts';

describe('what tmux says when it fails', () => {
  it.each([
    ['no server running on /tmp/tmux-1000/app\n', 'no-server'],
    ['error connecting to /tmp/tmux-1000/app (No such file or directory)\n', 'no-server'],
    ['error connecting to /tmp/tmux-1000/app (Connection refused)\n', 'no-server'],
    ['error connecting to /tmp/tmux-1000/app (File name too long)\n', 'other'],
    ['error connecting to /tmp/tmux-1000/app (Permission denied)\n', 'other'],
    ['server exited unexpectedly\n', 'no-server'],
    ["can't find session: chapter-1\n", 'no-session'],
    ["can't find window: 0\n", 'no-session'],
    ["can't find pane: 0\n", 'no-session'],
    // A server with no session left (its last one just ended, the server not yet gone).
    ['no current target\n', 'no-session'],
    ['duplicate session: chapter-1\n', 'duplicate-session'],
    ['command too long\n', 'other'],
    ['', 'other'],
    ['something new\n', 'other'],
  ])('reads %j as %s', (stderr, kind) => {
    expect(classifyFailure(stderr)).toBe(kind);
  });
});

describe('the socket a server that ended left behind', () => {
  it('is the path tmux found no server on', () => {
    expect(socketLeftBehind('no server running on /tmp/tmux-1000/my app\n')).toBe(
      '/tmp/tmux-1000/my app',
    );
  });

  it('is the path tmux could not connect to, no server listening on its file', () => {
    expect(
      socketLeftBehind('error connecting to /tmp/tmux-1000/my app (Connection refused)\n'),
    ).toBe('/tmp/tmux-1000/my app');
  });

  it.each([
    'error connecting to /tmp/tmux-1000/app (No such file or directory)\n',
    'server exited unexpectedly\n',
    "can't find session: no server running on /tmp/x\n",
    '',
  ])('is none in %j', (stderr) => {
    expect(socketLeftBehind(stderr)).toBeUndefined();
  });
});

describe('reading tmux’s output', () => {
  it('splits lines, dropping the empty ones', () => {
    expect(parseLines('a\nb-c\n')).toEqual(['a', 'b-c']);
    expect(parseLines('')).toEqual([]);
  });

  it('reads the screen: the copy-mode flag, then the rows', () => {
    expect(parseScreen('0\nfirst\n\n  third\n\n')).toEqual({
      inCopyMode: false,
      text: 'first\n\n  third\n',
    });
    expect(parseScreen('1\nrow\n')).toEqual({ inCopyMode: true, text: 'row' });
  });

  it('refuses a screen without its flag', () => {
    expect(() => parseScreen('row\n')).toThrow(/unexpected/);
    expect(() => parseScreen('')).toThrow(/unexpected/);
  });

  it('reads the process id', () => {
    expect(parseProcess('4242\n')).toEqual({ pid: 4242 });
  });

  it.each(['', '\n', 'abc\n', '0\n', '-4\n', '1 2\n'])('refuses the process id %j', (output) => {
    expect(() => parseProcess(output)).toThrow(/unexpected/);
  });

  it('reads the server’s process id and socket path, spaces in the path included', () => {
    expect(parseServer('977 /tmp/my tmux/tmux-1000/app\n')).toEqual({
      pid: 977,
      socketPath: '/tmp/my tmux/tmux-1000/app',
    });
  });

  it.each(['', 'x /tmp/a\n', '12\n', '12 \n'])('refuses the server line %j', (output) => {
    expect(() => parseServer(output)).toThrow(/unexpected/);
  });
});

describe('the names of the server’s own variables', () => {
  it('are read from the lines of its environment, a removed one included', () => {
    expect(parseVariableNames('HOME=/home/me\nEMPTY=\nodd name=1\nA=b=c\n-GONE\n')).toEqual([
      'HOME',
      'EMPTY',
      'odd name',
      'A',
      'GONE',
    ]);
  });

  it('take the lines of a value for names at worst, never miss a name', () => {
    expect(parseVariableNames('MULTI=one\nFAKE=1\nno name here\n=x\n\nLAST=1\n')).toEqual([
      'MULTI',
      'FAKE',
      'LAST',
    ]);
  });

  it('are none for a server with no variable', () => {
    expect(parseVariableNames('')).toEqual([]);
  });
});
