import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { TESTED_RANGE } from '../../src/claude-code/tested-range.ts';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-agent-version-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** Puts a `claude` in the folder that prints the text to `--version`, and only to it. */
function agentPrinting(text: string): void {
  const program = join(folder, 'claude');
  writeFileSync(
    program,
    `#!/bin/sh\n[ "$*" = "--version" ] || exit 70\nprintf '%s\\n' '${text}'\n`,
  );
  chmodSync(program, 0o755);
}

describe("the Claude Code driver's reading of the agent's version", () => {
  it("runs the claude of the environment's PATH, and stands its version against the range", async () => {
    agentPrinting(`${TESTED_RANGE.newest} (Claude Code)`);

    expect(await claudeCode().agentVersion({ PATH: folder })).toEqual({
      found: true,
      version: TESTED_RANGE.newest,
      standing: 'tested',
    });
  });

  it('tells a version newer than the range', async () => {
    agentPrinting('999.0.0 (Claude Code)');

    expect(await claudeCode().agentVersion({ PATH: folder })).toMatchObject({
      found: true,
      version: '999.0.0',
      standing: 'newer',
    });
  });

  it('finds no agent where the PATH has no claude', async () => {
    expect(await claudeCode().agentVersion({ PATH: folder })).toEqual({
      found: false,
      command: 'claude',
    });
  });

  it('fails when the agent prints no version, or exits with an error', async () => {
    agentPrinting('Claude Code');
    await expect(claudeCode().agentVersion({ PATH: folder })).rejects.toThrow('no version');

    writeFileSync(join(folder, 'claude'), '#!/bin/sh\nexit 70\n');
    await expect(claudeCode().agentVersion({ PATH: folder })).rejects.toMatchObject({ code: 70 });
  });
});
