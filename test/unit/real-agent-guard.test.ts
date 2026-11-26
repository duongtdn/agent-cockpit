import { describe, expect, it } from 'vitest';
import { assertStaysLocal } from '../support/real-agent/guard.ts';

const root = '/tmp/cockpit-real-agent-abc';
const local = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010',
  HOME: `${root}/home`,
  CLAUDE_CONFIG_DIR: `${root}/config`,
};

function check(changes: Record<string, string | undefined>): () => void {
  const environment = Object.fromEntries(
    Object.entries({ ...local, ...changes }).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  return () => assertStaysLocal(environment, root);
}

describe('the guard of the real agent', () => {
  it('lets an agent start whose API is on the loopback and whose folders are in its root', () => {
    expect(check({})).not.toThrow();
    expect(check({ ANTHROPIC_BASE_URL: 'http://[::1]:4010' })).not.toThrow();
  });

  it.each([
    ['no address at all', undefined],
    ['what is no address', 'not a url'],
    ["Anthropic's API", 'https://api.anthropic.com'],
    ['a name, even one that means this machine', 'http://localhost:4010'],
    ['a host that only begins like the loopback', 'http://127.0.0.1.example.com:4010'],
    ['a loopback address given as the user of another host', 'http://127.0.0.1@example.com'],
    ['an address of the local network', 'http://192.168.1.10:4010'],
    ['every address of the machine', 'http://0.0.0.0:4010'],
  ])('refuses an API at %s', (_what, url) => {
    expect(check({ ANTHROPIC_BASE_URL: url })).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it.each(['HOME', 'CLAUDE_CONFIG_DIR'])(
    'refuses a %s that is missing, outside the root, or the root itself',
    (name) => {
      for (const folder of [
        undefined,
        '/home/someone',
        `${root}-other/x`,
        `${root}/../x`,
        root,
        'home',
      ]) {
        expect(check({ [name]: folder })).toThrow(new RegExp(name));
      }
    },
  );
});
