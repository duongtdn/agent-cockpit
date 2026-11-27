import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentVersionReader } from '../../src/claude-code/agent-version.ts';
import { claudeCode } from '../../src/claude-code/index.ts';
import { TESTED_RANGE } from '../../src/claude-code/tested-range.ts';
import { NEVER_S, PATIENCE } from '../support/patience.ts';

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

  it('reads a suffixed build as untested, and keeps its suffix', async () => {
    agentPrinting('2.1.340-beta (Claude Code)');

    expect(await claudeCode().agentVersion({ PATH: folder })).toEqual({
      found: true,
      version: '2.1.340-beta',
      standing: 'untested',
    });
  });

  it('tells an agent that prints no version, or exits with an error, as one that cannot be run: why, and what it printed', async () => {
    agentPrinting('Claude Code');
    expect(await claudeCode().agentVersion({ PATH: folder })).toEqual({
      found: false,
      command: 'claude',
      failure: { reason: 'claude --version printed no version', output: 'Claude Code\n' },
    });

    writeFileSync(join(folder, 'claude'), '#!/bin/sh\necho broken >&2\nexit 70\n');
    expect(await claudeCode().agentVersion({ PATH: folder })).toEqual({
      found: false,
      command: 'claude',
      failure: { reason: 'claude --version exited with status 70', output: 'broken\n' },
    });
  });

  it('gives up on an agent that does not answer in time, ending it and what it started', async () => {
    const marker = join(folder, 'still-running');
    writeFileSync(
      join(folder, 'claude'),
      `#!/bin/sh\necho starting\nsh -c 'sleep ${NEVER_S}; touch "$1"' sh '${marker}'\n`,
    );
    chmodSync(join(folder, 'claude'), 0o755);
    const read = agentVersionReader(TESTED_RANGE, 200);

    const started = Date.now();
    expect(await read({ PATH: `${folder}:/usr/bin:/bin` })).toEqual({
      found: false,
      command: 'claude',
      failure: { reason: 'claude --version did not answer within 0.2 s', output: 'starting\n' },
    });
    expect(Date.now() - started).toBeLessThan(PATIENCE.condition);
    // What the agent started was ended with it: nothing is left to leave a mark.
    const grandchildren = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
    expect(grandchildren.stdout).toBe('');
  });

  it('cuts what an agent printed to a few kilobytes', async () => {
    writeFileSync(
      join(folder, 'claude'),
      '#!/bin/sh\nhead -c 100000 /dev/zero | tr "\\0" x\nexit 1\n',
    );
    chmodSync(join(folder, 'claude'), 0o755);

    const reading = await claudeCode().agentVersion({ PATH: `${folder}:/usr/bin:/bin` });

    expect(reading).toMatchObject({
      found: false,
      failure: { reason: 'claude --version exited with status 1' },
    });
    const { output } = (reading as { failure: { output: string } }).failure;
    expect(output.length).toBeLessThanOrEqual(4096 + 20);
    expect(output).toMatch(/…$/);
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
    expect(await driver.agentVersion({ PATH: folder })).toMatchObject({ found: false });

    expect(await driver.agentVersion({ PATH: folder })).toMatchObject({ found: false });
    expect(runs()).toBe(2);
  });

  it('runs it again once replaced by another file, its time of change kept', async () => {
    const driver = claudeCode();
    const program = agentPrinting('2.1.332 (Claude Code)');
    // A time of change in whole seconds, which a file is given again exactly.
    const mtime = new Date('2026-01-01T00:00:00Z');
    utimesSync(program, mtime, mtime);
    await driver.agentVersion({ PATH: folder });

    const replacement = join(folder, 'replacement');
    mkdirSync(replacement);
    agentPrinting('999.0.0 (Claude Code)', replacement);
    utimesSync(join(replacement, 'claude'), mtime, mtime);
    renameSync(join(replacement, 'claude'), program);

    expect(await driver.agentVersion({ PATH: folder })).toMatchObject({ version: '999.0.0' });
    expect(runs()).toBe(2);
  });

  it('runs it again once rewritten in place, its time of change set back', async () => {
    const driver = claudeCode();
    const program = agentPrinting('2.1.332 (Claude Code)');
    // A time of change in whole seconds, which a file is given again exactly.
    const mtime = new Date('2026-01-01T00:00:00Z');
    utimesSync(program, mtime, mtime);
    await driver.agentVersion({ PATH: folder });

    agentPrinting('999.0.0 (Claude Code)');
    utimesSync(program, mtime, mtime);

    expect(await driver.agentVersion({ PATH: folder })).toMatchObject({ version: '999.0.0' });
    expect(runs()).toBe(2);
  });

  it('is the driver’s own: another driver reads the agent anew', async () => {
    agentPrinting('2.1.332 (Claude Code)');

    await claudeCode().agentVersion({ PATH: folder });
    await claudeCode().agentVersion({ PATH: folder });

    expect(runs()).toBe(2);
  });
});
