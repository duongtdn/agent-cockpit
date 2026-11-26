import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
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

  it('refuses a state-changing request of the app’s API from a page of another origin, the token with it', async () => {
    for (const origin of [`http://127.0.0.1:${Number(portOf(app.link)) + 1}`, 'http://localhost']) {
      const answer = await fetch(`${originOf(app.link)}/api/renew-token`, {
        method: 'POST',
        headers: { [TOKEN_HEADER]: tokenOf(app.link), origin },
      });

      expect(answer.status, origin).toBe(403);
      expect(await answer.json()).toMatchObject({ error: 'wrong-origin' });
    }
    await page.reload();
    await page.getByText(FOLLOWING).waitFor();
  });

  it('refuses a page of the network, and its sign-in finds the app not opened', async () => {
    const lan = networkAddress('IPv4');
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
  /** The link the renewal printed. */
  let newLink: string;

  beforeAll(async () => {
    app = await startOnAFreePort(['--open']);
    local = await newPage();
    remote = await newPage();
    await local.goto(app.link);
    await local.getByText(FOLLOWING).waitFor();
  });

  afterAll(async () => {
    await stopLeavingNothing(app);
  });

  it('refuses a page of the network until it signs in with the password, then serves it', async () => {
    const lan = networkAddress('IPv4');
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

  it('signs in for a stated time, from the app’s own origins only', async () => {
    const signIn = (origin: string) =>
      fetch(`${originOf(app.link)}/api/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ password: passwordOf(app) }),
      });

    const fromAnother = await signIn(`http://127.0.0.1:${Number(portOf(app.link)) + 1}`);
    const fromItsOwn = await signIn(originOf(app.link));

    expect(fromAnother.status).toBe(403);
    expect(fromAnother.headers.get('set-cookie')).toBeNull();
    expect(fromItsOwn.status).toBe(204);
    expect(fromItsOwn.headers.get('set-cookie')).toMatch(
      /^translate-and-access-sign-in=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/,
    );
  });

  it('renews the token only for a page with the token: a sign-in alone is refused', async () => {
    await remote.getByRole('button', { name: 'Renew the token' }).click();

    await remote.getByText('The app refused to renew the token (401).').waitFor();
    await local.getByText(FOLLOWING).waitFor();
  });

  it('signs a page of the network out: refused again, until it signs in again', async () => {
    await remote.getByRole('button', { name: 'Sign out' }).click();

    await remote.getByText('The cockpit refused this page (refused · remote).').waitFor();
    await remote.getByText('The app’s API refused this page (401).').waitFor();
    expect(await remote.getByRole('button', { name: 'Sign in' }).isVisible()).toBe(true);
  });

  it('renews the token from the page: open sockets closed, the old link dead, the new one served', async () => {
    const renewed = app.nextLine(LINK_LINE);
    await local.getByRole('button', { name: 'Renew the token' }).click();
    newLink = (await renewed)[1] as string;

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
    await withTheNewLink.goto(newLink);
    await withTheNewLink.getByText(FOLLOWING).waitFor();
    await withTheNewLink.locator(`tr[data-key="${KEY}"]`).waitFor();
    await withTheNewLink
      .getByText('The app’s API knows this page by the app’s token, from 127.0.0.1.')
      .waitFor();
  });

  it('takes the new link opened in the tab that already shows the page: it follows again, its terminal too', async () => {
    await local.goto(newLink);

    await local.locator('#connection').getByText(FOLLOWING).waitFor();
    await local.locator('#terminal-status').getByText('(open)').waitFor();
    expect(local.url()).not.toContain('#');
  });
});

describe('translate and access, its link and its origins by --host', () => {
  it('gives a link on the loopback for --host localhost', async () => {
    const app = await startExampleApp('translate-and-access', [
      '--host',
      'localhost',
      '--port',
      '0',
    ]);
    try {
      expect(new URL(app.link).hostname).toBe('127.0.0.1');
      const page = await newPage();
      await page.goto(app.link);
      await page.getByText(FOLLOWING).waitFor();
    } finally {
      await stopLeavingNothing(app);
    }
  });

  it('gives a link on the address it listens on, for --host <an address of the network>', async () => {
    const lan = networkAddress('IPv4');
    const app = await startExampleApp('translate-and-access', ['--host', lan, '--port', '0']);
    try {
      expect(new URL(app.link).hostname).toBe(lan);
      expect(app.printed()).toContain('Not opened (--open)');
    } finally {
      await stopLeavingNothing(app);
    }
  });

  it('lets pages come from the machine’s IPv6 addresses too, with --open --host ::', async () => {
    const addresses = [networkAddress('IPv4'), networkAddress('IPv6')];
    const app = await startOnAFreePort(['--open', '--host', '::']);
    try {
      for (const address of addresses) {
        const answer = await sessionsFrom(address, Number(portOf(app.link)));

        // Refused only for lacking a sign-in: its Host and its Origin were allowed.
        expect(answer, JSON.stringify(address)).toMatchObject({
          status: 403,
          body: { error: { code: 'refused', cause: 'remote' } },
        });
      }
    } finally {
      await stopLeavingNothing(app);
    }
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

/**
 * An address of this machine beyond the loopback, where a request comes
 * from the network. A test that needs one fails without it, saying so.
 */
function networkAddress(family: 'IPv4'): string;
function networkAddress(family: 'IPv6'): NetworkInterfaceInfo;
function networkAddress(family: 'IPv4' | 'IPv6'): string | NetworkInterfaceInfo {
  const found = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === family && !entry.internal);
  if (found === undefined) {
    throw new Error(`This test needs an ${family} address of this machine beyond the loopback.`);
  }
  return family === 'IPv4' ? found.address : found;
}

/**
 * Asks the cockpit's sessions from one of the machine's addresses, as a
 * page there would: the request goes to that address, its `Host` and its
 * `Origin` name it.
 */
function sessionsFrom(
  entry: NetworkInterfaceInfo | string,
  port: number,
): Promise<{ status: number | undefined; body: unknown }> {
  const { address, scopeid } =
    typeof entry === 'string' ? { address: entry, scopeid: undefined } : entry;
  const named = address.includes(':') ? `[${address}]` : address;
  // A link-local address is reached through its interface; a URL cannot name it.
  const zone = scopeid ? `%${scopeid}` : '';
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: `${address}${zone}`,
        port,
        path: `/cockpit${SESSIONS_PATH}`,
        headers: { host: `${named}:${port}`, origin: `http://${named}:${port}` },
      },
      (answer) => {
        let text = '';
        answer.setEncoding('utf8');
        answer.on('data', (chunk) => (text += chunk));
        answer.on('end', () => resolve({ status: answer.statusCode, body: JSON.parse(text) }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Starts the example on a fixed port that was free a moment before: `--open`
 * needs one, since the origins it allows name it. Another process may take
 * the port in between; the start is then tried again on another.
 */
async function startOnAFreePort(args: readonly string[]): Promise<ExampleApp> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startExampleApp('translate-and-access', [
        ...args,
        '--port',
        `${await freePort()}`,
      ]);
    } catch (error) {
      if (attempt === 3 || !String(error).includes('EADDRINUSE')) throw error;
    }
  }
}

/** A port free on every address at the time asked. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port.');
  return address.port;
}
