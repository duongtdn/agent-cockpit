import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseVersion, standingOf } from '../../src/claude-code/agent-version.ts';
import { claudeCode } from '../../src/claude-code/index.ts';
import { TESTED_RANGE } from '../../src/claude-code/tested-range.ts';

const RANGE = { oldest: '2.1.330', newest: '2.1.332' };

describe("the agent's version against the tested range", () => {
  it.each([
    ['2.1.330', 'tested'],
    ['2.1.331', 'tested'],
    ['2.1.332', 'tested'],
    ['2.1.333', 'newer'],
    ['2.2.0', 'newer'],
    ['10.0.0', 'newer'],
    ['2.1.329', 'older'],
    ['2.0.999', 'older'],
    ['1.99.99', 'older'],
    // A suffixed build is one no test ran on, whatever its numbers: unless they are older.
    ['2.1.330-beta', 'untested'],
    ['2.1.331-rc.1', 'untested'],
    ['2.1.332+local', 'untested'],
    ['2.1.340-beta', 'untested'],
    ['2.1.329-beta', 'older'],
  ] as const)('counts %s as %s', (version, standing) => {
    expect(standingOf(version, RANGE)).toBe(standing);
  });
});

describe("the agent's answer to --version", () => {
  it('gives the version Claude Code prints', () => {
    expect(parseVersion('2.1.332 (Claude Code)\n')).toBe('2.1.332');
  });

  it.each([
    ['2.1.340-beta (Claude Code)\n', '2.1.340-beta'],
    ['2.1.340-rc.1+build.7 (Claude Code)', '2.1.340-rc.1+build.7'],
    ['2.1.340+local', '2.1.340+local'],
  ])('gives a version with a suffix as printed: %j', (printed, version) => {
    expect(parseVersion(printed)).toBe(version);
  });

  it.each([
    '',
    'Claude Code',
    'v2.1',
    '2.1 (Claude Code)',
    '2.1.340- (Claude Code)',
    '2.1.340-beta!',
    '2.1.340beta',
  ])('reads no version in %j', (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });
});

describe("the driver's tested range", () => {
  it('holds the pinned agent the contract tests run', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const pinned: string = manifest.devDependencies['@anthropic-ai/claude-code'];

    expect(standingOf(pinned, TESTED_RANGE)).toBe('tested');
    expect(claudeCode().testedRange).toEqual(TESTED_RANGE);
  });
});
