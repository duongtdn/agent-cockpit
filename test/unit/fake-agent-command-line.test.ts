import { describe, expect, it } from 'vitest';
import { parseCommandLine } from '../support/fake-agent/command-line.ts';

const ID = '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11';

describe("the fake agent's command line, read as Claude Code's", () => {
  it('reads a new session: its id, its settings file and its permission mode', () => {
    const line = parseCommandLine([
      '--session-id',
      ID,
      '--settings',
      '/state/settings.json',
      '--permission-mode',
      'acceptEdits',
    ]);

    expect(line).toEqual({
      sessionId: ID,
      resumes: false,
      settingsFile: '/state/settings.json',
      permissionMode: 'acceptEdits',
      prompt: undefined,
    });
  });

  it('reads a resumed session: the same id, marked as resumed (behavior 3)', () => {
    expect(parseCommandLine(['--resume', ID])).toMatchObject({ sessionId: ID, resumes: true });
  });

  it('takes the default permission mode and no settings when none is given', () => {
    expect(parseCommandLine(['--session-id', ID])).toMatchObject({
      permissionMode: 'default',
      settingsFile: undefined,
    });
  });

  it('reads what follows -- as the prompt, whatever options precede it (behavior 29)', () => {
    const line = parseCommandLine([
      '--session-id',
      ID,
      '--mcp-config',
      '/state/mcp.json',
      '--',
      '--not an option',
    ]);

    expect(line.prompt).toBe('--not an option');
  });

  it('reads a word after an option of several values as one more value, not as the prompt', () => {
    const line = parseCommandLine(['--session-id', ID, '--mcp-config', '/state/mcp.json', 'hello']);

    expect(line.prompt).toBeUndefined();
  });

  it('accepts the other options a session is launched with', () => {
    const line = parseCommandLine([
      '--resume',
      ID,
      '--model',
      'haiku',
      '--plugin-dir',
      '/app/plugin',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--',
      'go on',
    ]);

    expect(line).toMatchObject({ sessionId: ID, resumes: true, prompt: 'go on' });
  });

  it('refuses an option a session is never launched with', () => {
    expect(() => parseCommandLine(['--session-id', ID, '--print'])).toThrow(
      'unknown option --print',
    );
  });

  it('refuses an option whose value is missing', () => {
    expect(() => parseCommandLine(['--session-id'])).toThrow('--session-id needs a value');
  });

  it('refuses a launch that names no session', () => {
    expect(() => parseCommandLine(['--settings', '/state/settings.json'])).toThrow(
      'one of --session-id and --resume is needed',
    );
  });

  it('refuses more than one prompt', () => {
    expect(() => parseCommandLine(['--session-id', ID, '--', 'one', 'two'])).toThrow(
      'one prompt at most',
    );
  });
});
