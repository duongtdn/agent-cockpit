import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOLLOW_SESSIONS_PATH, WIRE_SUBPROTOCOL, wireSubprotocols } from '../../src/shared/wire.ts';
import { type ExampleApp, startExampleApp } from '../support/example-app.ts';

/**
 * The jobs console end to end, as a person uses it: the example started as
 * its DEMO.md says (the pinned agent against the scripted API), a real
 * Chromium on its link. Each test goes on from where the one before left the
 * page; every wait is on what the page shows.
 */

/** The answer the example's fake API gives to every question. */
const SCRIPTED_ANSWER = 'scripted answer of the fake API';
/** The session a run on `README.md` has. */
const KEY = 'explain-readme-md';
/** Another site's name, which the browser resolves to the loopback address. */
const OTHER_SITE = 'other-site.test';
/** Shorter than the test's timeout, so that a failed wait says what it waited for. */
const WAIT_MS = 20_000;

let app: ExampleApp;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  app = await startExampleApp('jobs-console', ['--port', '0']);
  // A name of another site that leads to this machine, as DNS rebinding makes one.
  browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${OTHER_SITE} 127.0.0.1`] });
  page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(WAIT_MS);
});

afterAll(async () => {
  await browser?.close();
  if (app === undefined) return;
  const exitCode = await app.stop();
  expect(exitCode, app.printed()).toBe(0);
  expect(existsSync(temporaryRoot(app)), 'its temporary folder is removed').toBe(false);
});

/** The folder the example says its scripted agent keeps everything in. */
function temporaryRoot(example: ExampleApp): string {
  const root = /fake API, in (\S+)\.$/m.exec(example.printed())?.[1];
  if (root === undefined) throw new Error(`The example named no folder:\n${example.printed()}`);
  return root;
}

const row = () => page.locator(`tr[data-key="${KEY}"]`);
const terminal = () => page.locator('#terminal');

describe('the jobs console, against the scripted API', () => {
  it('opens on the printed link, and the token leaves the address bar', async () => {
    await page.goto(app.link);

    await page.getByText('Following the sessions.').waitFor();
    await page.getByText('No sessions yet').waitFor();
    expect(page.url()).not.toContain('#');
    expect(page.url()).not.toContain(new URL(app.link).hash.slice(1));
  });

  it('runs the job: the session goes busy, then idle with the answer', async () => {
    await page.getByLabel('File', { exact: true }).fill('README.md');
    await page.getByRole('button', { name: 'Run' }).click();

    await page.getByText('Started a session on README.md: it is busy.').waitFor();
    await row().locator('td[data-state="idle"]').waitFor();
    expect(await row().locator('td').nth(2).textContent()).toMatch(/busy → idle$/);
    expect(await row().locator('.last-answer').textContent()).toContain(SCRIPTED_ANSWER);
  });

  it('shows the agent’s answer in the session’s terminal', async () => {
    await page.getByRole('button', { name: `Open the terminal of ${KEY}` }).click();

    await page.getByText('(open)').waitFor();
    await terminal().getByText(SCRIPTED_ANSWER).waitFor();
  });

  it('works again when the page is reopened without the link’s fragment', async () => {
    const reopened = page.url();
    expect(reopened).not.toContain('#');

    await page.goto('about:blank');
    await page.goto(reopened);

    await row().locator('td[data-state="idle"]').waitFor();
    await terminal().getByText(SCRIPTED_ANSWER).waitFor();
  });

  it('keeps the token to the page’s origin: a page on another port has none', async () => {
    const other = await servePlainPage();
    try {
      const otherPage = await page.context().newPage();
      await otherPage.goto(`http://127.0.0.1:${other.port}/`);

      expect(await otherPage.evaluate(() => localStorage.length)).toBe(0);
      expect(await opensWebSocket(otherPage, followUrl(), [WIRE_SUBPROTOCOL])).toBe('refused');
    } finally {
      await other.close();
    }
  });

  it('refuses a page of another site, even one that holds the token', async () => {
    const token = new URL(app.link).hash.replace('#cockpit=', '');
    const other = await servePlainPage();
    try {
      const otherPage = await page.context().newPage();
      await otherPage.goto(`http://${OTHER_SITE}:${other.port}/`);

      expect(await opensWebSocket(page, followUrl(), wireSubprotocols(token))).toBe('open');
      expect(await opensWebSocket(otherPage, followUrl(), wireSubprotocols(token))).toBe('refused');
    } finally {
      await other.close();
    }
  });
});

/** Opens a WebSocket from a page, as its own script would: it opens, or the server refuses it. */
function opensWebSocket(
  from: Page,
  url: string,
  protocols: readonly string[],
): Promise<'open' | 'refused'> {
  return from.evaluate(
    ({ url, protocols }) =>
      new Promise<'open' | 'refused'>((resolve) => {
        const socket = new WebSocket(url, protocols);
        socket.onopen = () => {
          socket.close();
          resolve('open');
        };
        socket.onerror = () => resolve('refused');
      }),
    { url, protocols: [...protocols] },
  );
}

/** The address the page follows the sessions at. */
function followUrl(): string {
  return `ws://${new URL(app.link).host}/cockpit${FOLLOW_SESSIONS_PATH}`;
}

/** A page of another app, on a loopback port of its own. */
async function servePlainPage(): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Other</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
