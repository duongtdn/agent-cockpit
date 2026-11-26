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

    expect(hooksFor(parsed, 'Stop', undefined)).toEqual([
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

    expect(hooksFor(parsed, 'Stop', undefined)).toEqual([
      { type: 'http', url: 'http://127.0.0.1:1/stop', headers: {} },
    ]);
  });

  it('gives SessionStart its command hooks and never its HTTP hooks (behavior 1)', () => {
    const parsed = parseHookSettings(
      settings({ SessionStart: [{ matcher: '*', hooks: [http('SessionStart'), command] }] }),
    );

    expect(hooksFor(parsed, 'SessionStart', undefined)).toEqual([
      { type: 'command', command: 'report SessionStart' },
    ]);
  });

  it('gives an event the hooks of all its groups, in the order of the file', () => {
    const parsed = parseHookSettings(
      settings({ SessionEnd: [{ hooks: [http('SessionEnd')] }, { hooks: [command] }] }),
    );

    expect(hooksFor(parsed, 'SessionEnd', undefined).map((hook) => hook.type)).toEqual([
      'http',
      'command',
    ]);
  });

  it('gives a tool only the hooks whose matcher names it', () => {
    const parsed = parseHookSettings(
      settings({
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [http('question')] },
          { matcher: 'Bash|Write', hooks: [http('edits')] },
          { matcher: '', hooks: [http('all')] },
        ],
      }),
    );

    const addresses = hooksFor(parsed, 'PreToolUse', 'Bash').map(
      (hook) => hook.type === 'http' && hook.url,
    );

    expect(addresses).toEqual([
      'http://127.0.0.1:8765/hook/edits',
      'http://127.0.0.1:8765/hook/all',
    ]);
  });

  it('gives an event the settings do not name no hooks', () => {
    expect(hooksFor(parseHookSettings(settings({})), 'Stop', undefined)).toEqual([]);
    expect(hooksFor(parseHookSettings('{}'), 'Stop', undefined)).toEqual([]);
  });

  it('refuses a hook of a type it cannot play', () => {
    expect(() =>
      parseHookSettings(settings({ Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check.' }] }] })),
    ).toThrow('a hook of type "prompt"');
  });
});
