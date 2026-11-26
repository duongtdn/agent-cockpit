import { describe, expect, it } from 'vitest';
import {
  compareTmuxVersions,
  isSupportedTmuxVersion,
  parseTmuxVersion,
  type TmuxVersion,
} from '../../src/server/session-host/tmux-version.ts';

function version(text: string): TmuxVersion {
  const parsed = parseTmuxVersion(`tmux ${text}\n`);
  if (parsed === undefined) throw new Error(`not a version: ${text}`);
  return parsed;
}

describe('parsing what `tmux -V` prints', () => {
  it.each([
    ['3.2', { major: 3, minor: 2, stage: 'release', patch: '', text: '3.2' }],
    ['3.2a', { major: 3, minor: 2, stage: 'release', patch: 'a', text: '3.2a' }],
    ['3.10', { major: 3, minor: 10, stage: 'release', patch: '', text: '3.10' }],
    ['next-3.5', { major: 3, minor: 5, stage: 'next', patch: '', text: 'next-3.5' }],
    ['3.3-rc', { major: 3, minor: 3, stage: 'candidate', patch: '', text: '3.3-rc' }],
    ['3.3-rc2', { major: 3, minor: 3, stage: 'candidate', patch: '', text: '3.3-rc2' }],
  ])('reads %s', (text, expected) => {
    expect(version(text)).toEqual(expected);
  });

  it.each([
    '',
    'tmux',
    'tmux master',
    'tmux openbsd-7.4',
    'tmux 3',
    'screen 3.2a',
    'tmux 3.2a extra',
  ])('reads no version from %j', (output) => {
    expect(parseTmuxVersion(output)).toBeUndefined();
  });
});

describe('the order of tmux versions', () => {
  const ascending = [
    '2.9a',
    'next-3.2',
    '3.2-rc',
    '3.2',
    '3.2a',
    'next-3.3',
    '3.3',
    '3.3a',
    '3.4',
    '3.10',
    '4.0',
  ];

  it('sorts releases, their patch letters and the builds before a release', () => {
    const shuffled = [...ascending].reverse().map(version);

    expect(shuffled.sort(compareTmuxVersions).map(({ text }) => text)).toEqual(ascending);
  });

  it('finds a version equal to itself', () => {
    expect(compareTmuxVersions(version('3.2a'), version('3.2a'))).toBe(0);
  });

  it.each(['3.2a', '3.2b', 'next-3.3', '3.3-rc', '3.3', '3.3a', '3.4', '3.10', '4.0'])(
    'supports %s',
    (text) => {
      expect(isSupportedTmuxVersion(version(text))).toBe(true);
    },
  );

  it.each(['3.2', 'next-3.2', '3.2-rc', '3.1c', '2.9a', '1.8'])('does not support %s', (text) => {
    expect(isSupportedTmuxVersion(version(text))).toBe(false);
  });
});
