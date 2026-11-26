import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const built = new URL('../../dist/claude-code/index.js', import.meta.url);
let files: string | undefined;

afterEach(() => {
  if (files) rmSync(files, { recursive: true, force: true });
});

describe('the built Claude Code driver', () => {
  it("runs the SessionStart hook from the build's JavaScript, which any Node of the range runs", async () => {
    const { claudeCode } = await import(built.href);
    files = mkdtempSync(join(tmpdir(), 'cockpit-built-driver-'));
    const { args } = await claudeCode().launch({
      key: 'k',
      conversationId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
      directory: files,
      files,
      hooks: { url: 'http://127.0.0.1:4100', token: 't' },
      environment: {},
      confinement: {
        stateRoots: [files],
        appAddresses: [{ host: '127.0.0.1', port: 8765 }],
        listener: { host: '127.0.0.1', port: 4100 },
      },
    });
    const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    const words = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${command}`], { encoding: 'utf8' })
      .trimEnd()
      .split('\n');

    expect(words[1]).toMatch(/dist\/claude-code\/session-start-hook\.js$/);
    expect(existsSync(words[1] as string)).toBe(true);
  });
});
