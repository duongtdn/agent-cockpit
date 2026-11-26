import { describe, expect, it } from 'vitest';
import {
  attachArguments,
  attachedArguments,
  byteWrites,
  chunkText,
  connectionArguments,
  keyArguments,
  killArguments,
  LIST_ARGUMENTS,
  liveArguments,
  processArguments,
  SHUT_DOWN_ARGUMENTS,
  screenArguments,
  socketNameFor,
  startArguments,
  textWrites,
} from '../../src/server/session-host/tmux-commands.ts';

describe('the socket name of an app', () => {
  it('keeps lower-case letters, digits and hyphens, behind a prefix of the cockpit', () => {
    expect(socketNameFor('my-app-2')).toBe('agent-cockpit-my-app-2');
  });

  it('never names the socket of the person’s own tmux server', () => {
    expect(socketNameFor('default')).not.toBe('default');
  });

  it.each([
    ['My App', 'agent-cockpit-_4d_y_20__41_pp'],
    ['a/b', 'agent-cockpit-a_2f_b'],
    ['a_b', 'agent-cockpit-a_5f_b'],
    ['../x', 'agent-cockpit-_2e__2e__2f_x'],
    ['café', 'agent-cockpit-caf_e9_'],
    ['a😀', 'agent-cockpit-a_1f600_'],
  ])('writes every other character of %j as its code point', (name, socket) => {
    expect(socketNameFor(name)).toBe(socket);
  });

  it('gives two names two sockets', () => {
    const names = ['ab', 'Ab', 'a-b', 'a_b', 'a b', 'a_20_b', 'a.b', 'a/b', 'a', ''];

    expect(new Set(names.map(socketNameFor)).size).toBe(names.length);
  });

  it('is never longer than 64 characters, so that the socket’s path fits a unix socket', () => {
    const exact = 'a'.repeat(50);

    expect(socketNameFor(exact)).toBe(`agent-cockpit-${exact}`);
    for (const name of [
      'a'.repeat(51),
      'a'.repeat(5000),
      'tiếng Việt '.repeat(20),
      '😀'.repeat(9),
    ]) {
      expect(socketNameFor(name)).toHaveLength(64);
    }
  });

  it('keeps the beginning of a long name readable, and ends with a hash of the whole', () => {
    expect(socketNameFor(`my-app-${'x'.repeat(100)}`)).toMatch(
      /^agent-cockpit-my-app-x{26}\.[0-9a-f]{16}$/,
    );
  });

  it('gives two long names two sockets, and none that a short name has', () => {
    const long = 'a'.repeat(60);
    const names = [long, `${long}b`, `${long}c`, long.toUpperCase()];
    const sockets = names.map(socketNameFor);

    expect(new Set(sockets).size).toBe(names.length);
    // No short name's socket holds a ".": only a hashed one does.
    expect(sockets.every((socket) => socket.includes('.'))).toBe(true);
    expect(socketNameFor('a.b')).not.toContain('.');
  });
});

describe('the connection to the app’s tmux server', () => {
  it('names the socket, reads no configuration file and speaks UTF-8', () => {
    expect(connectionArguments('agent-cockpit-app')).toEqual([
      '-L',
      'agent-cockpit-app',
      '-f',
      '/dev/null',
      '-u',
    ]);
  });
});

describe('the commands that start a session', () => {
  it('print the server’s own variables and a marker, then are read from the standard input', () => {
    expect(startArguments('marker-1')).toEqual([
      'start-server',
      ';',
      'show-environment',
      '-g',
      ';',
      'display-message',
      '-p',
      'marker-1',
      ';',
      'source-file',
      '-',
    ]);
  });

  it('refuse a marker tmux would read as a format or a command', () => {
    expect(() => startArguments('a#b')).toThrow(TypeError);
    expect(() => startArguments('a;')).toThrow(TypeError);
  });
});

describe('a session’s name in a tmux command', () => {
  it('is matched exactly, never as a prefix or a pattern', () => {
    expect(liveArguments('ab')).toEqual(['has-session', '-t', '=ab']);
  });

  it.each(['', 'a.b', 'a:b', 'a b', '=a', 'a*', 'a\nb', 'é'])('refuses %j', (name) => {
    expect(() => liveArguments(name)).toThrow(TypeError);
  });

  it.each(['a', 'chapter-1', 'A_b-9', '-x'])('accepts %j', (name) => {
    expect(liveArguments(name)).toEqual(['has-session', '-t', `=${name}`]);
  });
});

describe('cutting text into writes', () => {
  it('cuts at the length given, the rest last', () => {
    expect(chunkText('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
  });

  it('gives one write for a text that fits, none for an empty one', () => {
    expect(chunkText('abc', 3)).toEqual(['abc']);
    expect(chunkText('', 3)).toEqual([]);
  });

  it('counts code points, so no character is cut in two', () => {
    expect(chunkText('a😀b😀c', 2)).toEqual(['a😀', 'b😀', 'c']);
  });

  it('loses nothing', () => {
    const text = 'x;é漢😀\n'.repeat(101);

    expect(chunkText(text, 200).join('')).toBe(text);
    expect(chunkText(text, 200).every((chunk) => [...chunk].length <= 200)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses the length %j', (length) => {
    expect(() => chunkText('abc', length)).toThrow(RangeError);
  });
});

describe('the commands that type text', () => {
  const typed = (...words: string[]) => [
    'copy-mode',
    '-q',
    '-t',
    '=s:0.0',
    ';',
    'send-keys',
    '-t',
    '=s:0.0',
    '-l',
    '--',
    ...words,
  ];

  it('leave copy-mode, then type each chunk literally, options ended', () => {
    expect(textWrites('s', '-abc', 2)).toEqual([typed('-a'), typed('bc')]);
  });

  it('type nothing for an empty text', () => {
    expect(textWrites('s', '', 2)).toEqual([]);
  });

  it('keep a final semicolon from ending the command: it goes alone, escaped', () => {
    expect(textWrites('s', 'a;', 5)).toEqual([typed('a', '\\;')]);
    expect(textWrites('s', ';', 5)).toEqual([typed('\\;')]);
    expect(textWrites('s', 'a\\;', 5)).toEqual([typed('a\\', '\\;')]);
    expect(textWrites('s', ';;', 5)).toEqual([typed(';', '\\;')]);
  });

  it('leave a semicolon elsewhere as it is', () => {
    expect(textWrites('s', 'a;b', 5)).toEqual([typed('a;b')]);
  });
});

describe('the command that presses keys', () => {
  it('leaves copy-mode, then sends the keys by name', () => {
    expect(keyArguments('s', ['C-u', 'Enter'])).toEqual([
      'copy-mode',
      '-q',
      '-t',
      '=s:0.0',
      ';',
      'send-keys',
      '-t',
      '=s:0.0',
      'C-u',
      'Enter',
    ]);
  });

  it.each([
    'Enter',
    'Escape',
    'Tab',
    'BTab',
    'BSpace',
    'Space',
    'Up',
    'Down',
    'Left',
    'Right',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'IC',
    'DC',
    'F1',
    'F12',
    'C-u',
    'C-e',
    'M-x',
    'C-M-a',
    'M-Enter',
    'C-Left',
    'C-/',
  ])('knows the key %s', (key) => {
    expect(keyArguments('s', [key]).at(-1)).toBe(key);
  });

  it.each([
    '',
    'a',
    'Bogus',
    'enter',
    'S-Tab',
    'F13',
    'F0',
    'C-',
    'C-ab',
    '-l',
    'C-é',
    ';',
    'Enter;',
    'C-;',
    'M-;',
    'C-M-;',
  ])('refuses %j, which tmux would type as text or read as something else', (key) => {
    expect(() => keyArguments('s', [key])).toThrow(TypeError);
  });

  it('refuses to press no key', () => {
    expect(() => keyArguments('s', [])).toThrow(TypeError);
  });
});

describe('the commands that send bytes', () => {
  it('leave copy-mode, then send each byte as two hexadecimal digits', () => {
    expect(byteWrites('s', Uint8Array.of(0x1b, 0x0d, 0x00, 0xff))).toEqual([
      [
        'copy-mode',
        '-q',
        '-t',
        '=s:0.0',
        ';',
        'send-keys',
        '-t',
        '=s:0.0',
        '-H',
        '1b',
        '0d',
        '00',
        'ff',
      ],
    ]);
  });

  it('send nothing for no byte', () => {
    expect(byteWrites('s', new Uint8Array())).toEqual([]);
  });

  it('send many bytes in several commands, each short enough for tmux', () => {
    const writes = byteWrites('s', new Uint8Array(2500).fill(0x41));

    expect(writes.map((write) => write.filter((word) => word === '41').length)).toEqual([
      1024, 1024, 452,
    ]);
  });
});

describe('the other commands', () => {
  it('read the copy-mode flag and the cursor, then the visible screen', () => {
    expect(screenArguments('s')).toEqual([
      'list-panes',
      '-t',
      '=s:0.0',
      '-f',
      '#{==:#{pane_index},0}',
      '-F',
      '#{pane_in_mode} #{cursor_x} #{cursor_y}',
      ';',
      'capture-pane',
      '-p',
      '-t',
      '=s:0.0',
    ]);
  });

  it('list the sessions by name', () => {
    expect(LIST_ARGUMENTS).toEqual(['list-sessions', '-F', '#{session_name}']);
  });

  it('read the process id of the session’s pane', () => {
    expect(processArguments('s')).toEqual([
      'list-panes',
      '-t',
      '=s:0.0',
      '-f',
      '#{==:#{pane_index},0}',
      '-F',
      '#{pane_pid}',
    ]);
  });

  it('list the session’s clients, each by the process of its terminal', () => {
    expect(attachedArguments('s')).toEqual(['list-clients', '-t', '=s', '-F', '#{client_pid}']);
  });

  it('kill the session', () => {
    expect(killArguments('s')).toEqual(['kill-session', '-t', '=s']);
  });

  it('attach a client to the session', () => {
    expect(attachArguments('s')).toEqual(['attach-session', '-t', '=s']);
  });

  it('ask the server for its process and socket, then kill it, and start none', () => {
    expect(SHUT_DOWN_ARGUMENTS).toEqual([
      'display-message',
      '-p',
      '#{pid} #{socket_path}',
      ';',
      'kill-server',
    ]);
  });
});
