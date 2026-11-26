import { describe, expect, it } from 'vitest';
import { requestRouteOf, socketRouteOf } from '../../src/server/http/router.ts';

describe('the routes of HTTP requests, under the mount', () => {
  it('runs a job on POST /run', () => {
    expect(requestRouteOf('POST', '/run')).toEqual({ route: 'run' });
  });

  it('lists the sessions on GET /sessions, a query or not', () => {
    expect(requestRouteOf('GET', '/sessions')).toEqual({ route: 'sessions' });
    expect(requestRouteOf('GET', '/sessions?x=1')).toEqual({ route: 'sessions' });
  });

  it('answers another method on a known path with the one it takes', () => {
    expect(requestRouteOf('GET', '/run')).toEqual({ route: 'wrong-method', allow: 'POST' });
    expect(requestRouteOf('DELETE', '/sessions')).toEqual({ route: 'wrong-method', allow: 'GET' });
  });

  it('tells a plain request to the sessions’ WebSocket path that it needs an upgrade', () => {
    expect(requestRouteOf('GET', '/follow/sessions')).toEqual({ route: 'upgrade-required' });
    expect(requestRouteOf('POST', '/follow/sessions')).toEqual({ route: 'upgrade-required' });
  });

  it('takes a GET on a terminal’s path as its probe, which explains a refused handshake', () => {
    expect(requestRouteOf('GET', '/terminal/explain-a')).toEqual({
      route: 'terminal-probe',
      key: 'explain-a',
    });
    expect(requestRouteOf('GET', '/terminal/explain-a?x=1')).toEqual({
      route: 'terminal-probe',
      key: 'explain-a',
    });
    expect(requestRouteOf('POST', '/terminal/explain-a')).toEqual({
      route: 'wrong-method',
      allow: 'GET',
    });
  });

  it.each([
    '/',
    '',
    '/runs',
    '/run/',
    '/sessions/x',
    '/cockpit/run',
    '/terminal/',
    '/terminal/Upper',
    '/terminal/a/b',
    '/follow',
    '//run',
  ])('knows no route at %j', (path) => {
    expect(requestRouteOf('GET', path)).toEqual({ route: 'unknown' });
    expect(requestRouteOf('POST', path)).toEqual({ route: 'unknown' });
  });
});

describe('the routes of WebSocket upgrades, under the mount', () => {
  it('follows the sessions on /follow/sessions', () => {
    expect(socketRouteOf('/follow/sessions')).toEqual({ route: 'follow-sessions' });
  });

  it("bridges a session's terminal on /terminal/<key>", () => {
    expect(socketRouteOf('/terminal/explain-readme')).toEqual({
      route: 'terminal',
      key: 'explain-readme',
    });
    expect(socketRouteOf('/terminal/a-1?x=1')).toEqual({ route: 'terminal', key: 'a-1' });
  });

  it.each([
    '/run',
    '/sessions',
    '/terminal/',
    '/terminal/a%2Fb',
    '/terminal/A',
    '/follow/sessions/x',
    '/',
  ])('knows no route at %j', (path) => {
    expect(socketRouteOf(path)).toBeUndefined();
  });
});
