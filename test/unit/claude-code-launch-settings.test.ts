import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { MAX_LAUNCH_PROMPT_BYTES } from '../../src/claude-code/launching.ts';

describe("a Claude Code session's launch settings", () => {
  it('are the same for the same options and part, and read back from JSON unchanged', () => {
    const driver = claudeCode({ permissionMode: 'acceptEdits', permissions: { deny: ['Bash'] } });
    const part = claudeCode.job({ model: 'sonnet' });

    const settings = driver.launchSettings(part);

    expect(driver.launchSettings(part)).toEqual(settings);
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
  });

  it("lay a job's part over the app's options: its mode, its rules added, its model", () => {
    const driver = claudeCode({ permissions: { deny: ['Bash'] } });
    const part = claudeCode.job({
      permissionMode: 'plan',
      permissions: { deny: ['Edit'] },
      model: 'opus',
    });

    expect(driver.launchSettings(part)).toMatchObject({
      permissionMode: 'plan',
      permissions: { deny: ['Bash', 'Edit'] },
      model: 'opus',
    });
  });

  it('differ for a part that changes what reaches the launch', () => {
    const driver = claudeCode();

    expect(driver.launchSettings(claudeCode.job({ permissionMode: 'plan' }))).not.toEqual(
      driver.launchSettings(),
    );
  });

  it.each([
    ['the model', { model: 'opus' }],
    ['the plugin', { pluginDir: '/tmp' }],
    ['the sources of settings', { settingSources: ['user' as const] }],
    ['the other MCP servers', { otherMcpServers: false }],
    ['the sandbox', { sandbox: true as const }],
  ])("differ for the app's options that change %s", (_, options) => {
    expect(claudeCode(options).launchSettings()).not.toEqual(claudeCode().launchSettings());
  });

  it('are the same whether or not the app accepts an open network: nothing of it reaches the launch', () => {
    expect(claudeCode({ acceptOpenNetwork: true }).launchSettings()).toEqual(
      claudeCode().launchSettings(),
    );
  });
});

describe('a first prompt on the command line', () => {
  const driver = claudeCode();

  it('fits up to the bound, in UTF-8 bytes', () => {
    expect(driver.promptFitsLaunch('a'.repeat(MAX_LAUNCH_PROMPT_BYTES))).toBe(true);
    expect(driver.promptFitsLaunch('a'.repeat(MAX_LAUNCH_PROMPT_BYTES + 1))).toBe(false);
  });

  it('fits 100,000 ASCII characters, and not 100,000 Vietnamese ones', () => {
    expect(driver.promptFitsLaunch('a'.repeat(100_000))).toBe(true);
    expect(driver.promptFitsLaunch('ệ'.repeat(100_000))).toBe(false);
  });

  it('keeps a margin below what one argument may hold on Linux, 128 KiB with its NUL', () => {
    expect(MAX_LAUNCH_PROMPT_BYTES).toBeLessThan(128 * 1024 - 1);
  });
});

describe('ending a Claude Code session', () => {
  it('sends SIGTERM, never typing /exit, and waits a few seconds before the host kills it', () => {
    const { ending } = claudeCode();

    expect(ending.signal).toBe('SIGTERM');
    expect(ending.boundMs).toBeGreaterThanOrEqual(2_000);
    expect(ending.boundMs).toBeLessThanOrEqual(10_000);
  });
});

describe('interrupting a Claude Code session', () => {
  it('presses one Esc on a busy session, never a second, which would open the rewind menu', () => {
    expect(claudeCode().interrupting.busy.keys).toEqual(['Escape']);
  });

  it('waits five seconds for the session to be idle, the bound the interrupt fails past', () => {
    expect(claudeCode().interrupting.boundMs).toBe(5_000);
  });
});
