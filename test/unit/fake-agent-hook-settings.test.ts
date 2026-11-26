import { describe, expect, it } from 'vitest';
import { hooksFor, parseHookSettings } from '../support/fake-agent/hook-settings.ts';

const http = (event: string) => ({
  type: 'http',
  url: `http://127.0.0.1:8765/hook/${event}`,
  headers: { Authorization: 'Bearer token' },
  timeout: 300,
});
const command = { type: 'command', command: 'report SessionStart' };

function settings(hooks: unknown): string {
  return JSON.stringify({ permissions: { allow: ['Bash(sleep:*)'] }, hooks });
}

describe("the hooks of the fake agent's settings file", () => {
  it('gives an event its HTTP hooks, with their address and headers (behavior 14)', () => {
    const parsed = parseHookSettings(settings({ Stop: [{ matcher: '*', hooks: [http('Stop')] }] }));

    expect(hooksFor(parsed, 'Stop')).toEqual([
      {
        type: 'http',
        url: 'http://127.0.0.1:8765/hook/Stop',
        headers: { Authorization: 'Bearer token' },
      },
    ]);
  });

  it('gives an HTTP hook without headers none', () => {
    const parsed = parseHookSettings(
      settings({ Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/stop' }] }] }),
    );

    expect(hooksFor(parsed, 'Stop')).toEqual([
      { type: 'http', url: 'http://127.0.0.1:1/stop', headers: {} },
    ]);
  });

  it('gives SessionStart its command hooks and never its HTTP hooks (behavior 1)', () => {
    const parsed = parseHookSettings(
      settings({ SessionStart: [{ matcher: '*', hooks: [http('SessionStart'), command] }] }),
    );

    expect(hooksFor(parsed, 'SessionStart')).toEqual([
      { type: 'command', command: 'report SessionStart' },
    ]);
  });

  it('gives an event the hooks of all its groups, in the order of the file', () => {
    const parsed = parseHookSettings(
      settings({ SessionEnd: [{ hooks: [http('SessionEnd')] }, { hooks: [command] }] }),
    );

    expect(hooksFor(parsed, 'SessionEnd').map((hook) => hook.type)).toEqual(['http', 'command']);
  });

  it('takes a group for every tool, with no matcher, an empty one or a star', () => {
    const parsed = parseHookSettings(
      settings({
        PreToolUse: [
          { hooks: [http('none')] },
          { matcher: '', hooks: [http('empty')] },
          { matcher: '*', hooks: [http('star')] },
        ],
      }),
    );

    expect(hooksFor(parsed, 'PreToolUse')).toHaveLength(3);
  });

  it.each(['AskUserQuestion', 'Bash|Write', 'mcp__.*'])(
    'refuses the matcher %j: the settings it plays select no tool',
    (matcher) => {
      expect(() =>
        parseHookSettings(settings({ PreToolUse: [{ matcher, hooks: [http('some')] }] })),
      ).toThrow(`the matcher ${JSON.stringify(matcher)}`);
    },
  );

  it('refuses an HTTP hook that is not plain http: the hooks it plays go to the loopback', () => {
    const hook = { type: 'http', url: 'https://127.0.0.1:8765/hook/Stop' };

    expect(() => parseHookSettings(settings({ Stop: [{ hooks: [hook] }] }))).toThrow(
      'an HTTP hook to "https://127.0.0.1:8765/hook/Stop"',
    );
  });

  it.each([
    ['what is no JSON', '{ "hooks": '],
    ['hooks that are no object', JSON.stringify({ hooks: [] })],
    ['an event whose groups are no list', settings({ Stop: {} })],
    ['a group without hooks', settings({ Stop: [{ matcher: '*' }] })],
    ['a command hook without its command', settings({ Stop: [{ hooks: [{ type: 'command' }] }] })],
    ['an HTTP hook without its address', settings({ Stop: [{ hooks: [{ type: 'http' }] }] })],
  ])('refuses %s, saying it cannot play the settings', (_what, text) => {
    expect(() => parseHookSettings(text)).toThrow(/^the fake agent cannot play /);
  });

  it('gives an event the settings do not name no hooks', () => {
    expect(hooksFor(parseHookSettings(settings({})), 'Stop')).toEqual([]);
    expect(hooksFor(parseHookSettings('{}'), 'Stop')).toEqual([]);
  });

  it('refuses a hook of a type it cannot play', () => {
    expect(() =>
      parseHookSettings(settings({ Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check.' }] }] })),
    ).toThrow('a hook of type "prompt"');
  });
});
