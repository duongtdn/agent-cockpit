import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paneTerminalType } from '../../src/server/session-host/tmux-terminal.ts';

let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-tmux-terminal-'));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A program in infocmp's place: a shell script. */
function infocmp(name: string, script: string): string {
  const executable = join(folder, name);
  writeFileSync(executable, `#!/bin/sh\n${script}\n`);
  chmodSync(executable, 0o755);
  return executable;
}

describe('the terminal type of the host’s panes', () => {
  it('is tmux-256color on a machine that describes it', async () => {
    const knows = infocmp('knows', '[ "$1" = tmux-256color ]');

    expect(await paneTerminalType(knows, 1000)).toBe('tmux-256color');
  });

  it('is screen-256color on a machine that does not', async () => {
    const lacks = infocmp('lacks', 'echo "infocmp: couldn\'t open terminfo file" >&2; exit 1');

    expect(await paneTerminalType(lacks, 1000)).toBe('screen-256color');
  });

  it('is screen-256color when the machine cannot tell', async () => {
    expect(await paneTerminalType(join(folder, 'not-installed'), 1000)).toBe('screen-256color');
    expect(await paneTerminalType(infocmp('hangs', 'exec sleep 30'), 50)).toBe('screen-256color');
  });
});
