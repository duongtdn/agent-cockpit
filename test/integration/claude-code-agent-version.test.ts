import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Puts a `claude` in the folder that prints the text to `--version`, and only
 * to it, and counts its runs in `runs` beside it.
 */
function agentPrinting(text: string, where = folder): string {
  const program = join(where, 'claude');
  writeFileSync(
    program,
    `#!/bin/sh\n[ "$*" = "--version" ] || exit 70\necho run >> '${join(folder, 'runs')}'\nprintf '%s\\n' '${text}'\n`,
  );
  chmodSync(program, 0o755);
  return program;
}

function runs(): number {
  try {
    return readFileSync(join(folder, 'runs'), 'utf8').split('\n').length - 1;
  } catch {
    return 0;
  }
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

  it('skips what the PATH holds under the name but cannot run: a folder, a file not executable', async () => {
    const [first, second, third] = ['a', 'b', 'c'].map((name) => join(folder, name));
    mkdirSync(join(first as string, 'claude'), { recursive: true });
    mkdirSync(second as string);
    writeFileSync(join(second as string, 'claude'), '#!/bin/sh\nexit 70\n', { mode: 0o644 });
    mkdirSync(third as string);
    agentPrinting('2.1.332 (Claude Code)', third);

    expect(await claudeCode().agentVersion({ PATH: `${first}:${second}:${third}` })).toMatchObject({
      version: '2.1.332',
    });
  });

  it('finds no agent with no PATH at all', async () => {
    expect(await claudeCode().agentVersion({})).toEqual({ found: false, command: 'claude' });
  });
});

describe("the Claude Code driver's version cache", () => {
  it('runs the same executable once: by its real path and time of change', async () => {
    const driver = claudeCode();
    const program = agentPrinting('2.1.332 (Claude Code)');
    const linked = join(folder, 'linked');
    mkdirSync(linked);
    symlinkSync(program, join(linked, 'claude'));

    const readings = [
      await driver.agentVersion({ PATH: folder }),
      await driver.agentVersion({ PATH: folder }),
      await driver.agentVersion({ PATH: linked }),
    ];

    expect(new Set(readings.map((reading) => JSON.stringify(reading))).size).toBe(1);
    expect(runs()).toBe(1);
  });

  it('runs it again once it changed, as an update of the agent changes it', async () => {
    const driver = claudeCode();
    const program = agentPrinting('2.1.332 (Claude Code)');
    await driver.agentVersion({ PATH: folder });

    agentPrinting('999.0.0 (Claude Code)');
    const later = new Date(Date.now() + 60_000);
    utimesSync(program, later, later);

    expect(await driver.agentVersion({ PATH: folder })).toMatchObject({
      version: '999.0.0',
      standing: 'newer',
    });
    expect(runs()).toBe(2);
  });

  it('keeps no failure: an agent that failed is run again', async () => {
    const driver = claudeCode();
    agentPrinting('Claude Code');
    await expect(driver.agentVersion({ PATH: folder })).rejects.toThrow('no version');

    await expect(driver.agentVersion({ PATH: folder })).rejects.toThrow('no version');
    expect(runs()).toBe(2);
  });

  it('is the driver’s own: another driver reads the agent anew', async () => {
    agentPrinting('2.1.332 (Claude Code)');

    await claudeCode().agentVersion({ PATH: folder });
    await claudeCode().agentVersion({ PATH: folder });

    expect(runs()).toBe(2);
  });
});
