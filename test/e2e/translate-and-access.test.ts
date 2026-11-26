import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSIONS_PATH, TOKEN_HEADER } from '../../src/shared/wire.ts';
import { type ExampleApp, LINK_LINE, startExampleApp } from '../support/example-app.ts';

/**
 * Translate and access end to end, its access half, as a person uses it:
 * the example started as its DEMO.md says (the pinned agent against the
 * scripted API), a real Chromium on its link on this machine, and on its
 * address on the network — a real address of this machine beyond the
 * loopback, so that the app sees a request from the network. Every wait is
 * on what a page shows or what the app prints.
 */

/** Shorter than the test's timeout, so that a failed wait says what it waited for. */
const WAIT_MS = 20_000;
/** The session a run for "Ada" has. */
const KEY = 'hello-ada';

const FOLLOWING = 'Following the sessions.';
const NO_TOKEN = 'This page has no valid token: open the link the server printed.';

let browser: Browser;
const lan = networkAddress();

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

describe('translate and access, not opened, listening on every address', () => {
  let app: ExampleApp;
  let page: Page;

  beforeAll(async () => {
    app = await startExampleApp('translate-and-access', ['--host', '0.0.0.0', '--port', '0']);
    page = await newPage();
  });

  afterAll(async () => {
    await stopLeavingNothing(app);
  });

  it('opens on the printed link, and the token leaves the address bar', async () => {
    await page.goto(app.link);

    await page.getByText(FOLLOWING).waitFor();
    await page.getByText('No sessions yet').waitFor();
    expect(await page.getByRole('button', { name: 'Sign in' }).isVisible()).toBe(false);
    expect(page.url()).not.toContain('#');
    expect(page.url()).not.toContain(tokenOf(app.link));
  });

  it('is known to the app’s API by the token’s header; without the header, refused', async () => {
    await page
      .getByText('The app’s API knows this page by the app’s token, from 127.0.0.1.')
      .waitFor();

    await page.getByRole('button', { name: 'Call the API without the token' }).click();

    await page.getByText('Without the token’s header, the app’s API answered 401.').waitFor();
  });

  it('refuses a request carrying a forwarding header, the token with it: forwarded', async () => {
    const answer = await fetch(`${originOf(app.link)}/cockpit${SESSIONS_PATH}`, {
      headers: { [TOKEN_HEADER]: tokenOf(app.link), 'x-forwarded-for': '203.0.113.7' },
    });

    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ error: { code: 'refused', cause: 'forwarded' } });
  });

  it('refuses a page of the network, and its sign-in finds the app not opened', async () => {
    const remote = await newPage();
    await remote.goto(`http://${lan}:${portOf(app.link)}/`);

    await remote.getByText('The cockpit refused this page (refused · remote).').waitFor();
    await remote.getByText('The app’s API refused this page (401).').waitFor();
    await remote.getByLabel('Password').fill('anything');
    await remote.getByRole('button', { name: 'Sign in' }).click();

    await remote
      .getByText('The app was started without --open: it serves no page of the network.')
      .waitFor();
  });
});

describe('translate and access, opened to the network with --open', () => {
  let app: ExampleApp;
  let local: Page;
  let remote: Page;

  beforeAll(async () => {
    app = await startExampleApp('translate-and-access', [
      '--open',
      '--port',
      `${await freePort()}`,
    ]);
    local = await newPage();
    remote = await newPage();
    await local.goto(app.link);
    await local.getByText(FOLLOWING).waitFor();
  });

  afterAll(async () => {
    await stopLeavingNothing(app);
  });

  it('refuses a page of the network until it signs in with the password, then serves it', async () => {
    await remote.goto(`http://${lan}:${portOf(app.link)}/`);
    await remote.getByText('The cockpit refused this page (refused · remote).').waitFor();

    await remote.getByLabel('Password').fill('not-the-password');
    await remote.getByRole('button', { name: 'Sign in' }).click();
    await remote.getByText('That is not the password the app printed.').waitFor();

    await remote.getByLabel('Password').fill(passwordOf(app));
    await remote.getByRole('button', { name: 'Sign in' }).click();
    await remote.getByText(FOLLOWING).waitFor();
    await remote.getByText(`The app’s API knows this page by its sign-in, from ${lan}.`).waitFor();
    expect(await remote.getByRole('button', { name: 'Sign in' }).isVisible()).toBe(false);
  });

  it('keeps the terminal from the page of the network, terminal-off, and serves it on this machine', async () => {
    await local.getByLabel('Name').fill('Ada');
    await local.getByRole('button', { name: 'Say hello' }).click();
    await remote.locator(`tr[data-key="${KEY}"]`).waitFor();

    await remote.getByRole('button', { name: `Open the terminal of ${KEY}` }).click();
    await remote
      .getByText('The terminal stays on the app’s machine (refused · terminal-off).')
      .waitFor();
    await remote.getByText('(closed)').waitFor();

    await local.getByRole('button', { name: `Open the terminal of ${KEY}` }).click();
    await local.getByText('(open)').waitFor();
  });

  it('renews the token from the page: open sockets closed, the old link dead, the new one served', async () => {
    const renewed = app.nextLine(LINK_LINE);
    await local.getByRole('button', { name: 'Renew the token' }).click();
    const [, newLink] = await renewed;

    await local
      .getByText('Renewed: every page needs the new link, printed in the server’s terminal.')
      .waitFor();
    // Its sockets were closed: each tried again, and was refused the old token.
    await local.locator('#connection').getByText(NO_TOKEN).waitFor();
    await local.locator('#terminal-error').getByText(NO_TOKEN).waitFor();
    expect(await local.locator('#terminal-status').textContent()).not.toBe('(open)');

    const withTheOldLink = await newPage();
    await withTheOldLink.goto(app.link);
    await withTheOldLink.getByText(NO_TOKEN).waitFor();

    const withTheNewLink = await newPage();
    await withTheNewLink.goto(newLink as string);
    await withTheNewLink.getByText(FOLLOWING).waitFor();
    await withTheNewLink.locator(`tr[data-key="${KEY}"]`).waitFor();
    await withTheNewLink
      .getByText('The app’s API knows this page by the app’s token, from 127.0.0.1.')
      .waitFor();
  });
});

/** A page in a browser context of its own: its own storage, its own cookies. */
async function newPage(): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(WAIT_MS);
  return page;
}

/** Stops the example, which must exit 0 and leave no temporary folder. */
async function stopLeavingNothing(app: ExampleApp | undefined): Promise<void> {
  if (app === undefined) return;
  const root = app.temporaryRoot();
  const exitCode = await app.stop();
  expect(exitCode, app.printed()).toBe(0);
  if (root === undefined) throw new Error(`The example named no folder:\n${app.printed()}`);
  expect(existsSync(root), 'its temporary folder is removed').toBe(false);
}

/** The password the example printed for a page of the network. */
function passwordOf(app: ExampleApp): string {
  const password = /^Password for a page of the network: (\S+)$/m.exec(app.printed())?.[1];
  if (password === undefined) throw new Error(`The example printed no password:\n${app.printed()}`);
  return password;
}

function tokenOf(link: string): string {
  return new URL(link).hash.replace('#cockpit=', '');
}

function originOf(link: string): string {
  return new URL(link).origin;
}

function portOf(link: string): string {
  return new URL(link).port;
}

/** An address of this machine beyond the loopback, where a request comes from the network. */
function networkAddress(): string {
  const found = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal);
  if (found === undefined) throw new Error('The test needs an IPv4 address beyond the loopback.');
  return found.address;
}

/**
 * A port free on every address: `--open` needs a fixed port, since the
 * origins it allows name it.
 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port.');
  return address.port;
}
