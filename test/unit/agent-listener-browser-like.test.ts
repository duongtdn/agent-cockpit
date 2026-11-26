import { describe, expect, it } from 'vitest';
import { looksLikeBrowser } from '../../src/server/agent-listener/browser-like.ts';

const PORT = 41234;

describe('whether a request to the agent-facing listener looks like a browser’s', () => {
  it('passes what the hooks send: Host 127.0.0.1 and the listener’s port, no Origin', () => {
    expect(looksLikeBrowser({ host: `127.0.0.1:${PORT}` }, PORT)).toBe(false);
  });

  it.each([
    ['a page’s origin', 'http://127.0.0.1:8765'],
    ['the listener’s own origin', `http://127.0.0.1:${PORT}`],
    ['an opaque origin', 'null'],
    ['an empty one', ''],
  ])('refuses any Origin header: %s', (_, origin) => {
    expect(looksLikeBrowser({ host: `127.0.0.1:${PORT}`, origin }, PORT)).toBe(true);
  });

  it.each([
    ['another name for loopback', `localhost:${PORT}`],
    ['another loopback address', `127.0.0.2:${PORT}`],
    ['IPv6 loopback', `[::1]:${PORT}`],
    ['a name a rebinding DNS points here', `attacker.example:${PORT}`],
    ['another port', `127.0.0.1:${PORT + 1}`],
    ['the port written otherwise', `127.0.0.1:0${PORT}`],
    ['no port', '127.0.0.1'],
    ['a trailing dot', `127.0.0.1.:${PORT}`],
    ['no Host at all', undefined],
  ])('refuses a Host other than its own: %s', (_, host) => {
    expect(looksLikeBrowser(host === undefined ? {} : { host }, PORT)).toBe(true);
  });
});
