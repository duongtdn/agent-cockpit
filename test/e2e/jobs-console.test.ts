import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Browser, chromium, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOLLOW_SESSIONS_PATH, WIRE_SUBPROTOCOL, wireSubprotocols } from '../../src/shared/wire.ts';
import { type ExampleApp, startExampleApp } from '../support/example-app.ts';

/**
 * The jobs console end to end, as a person uses it: the example started as
 * its DEMO.md says (the pinned agent against the scripted API, in a copy
 * of its sample project), a real Chromium on its link. Each test goes on
 * from where the one before left the page; every wait is on what the page
 * shows.
 */

/** The answer the example's fake API gives to every question. */
const SCRIPTED_ANSWER = 'scripted answer of the fake API';
/** The unit of work of the sample project's `src/greet.js`, which Explain and Review share. */
const GREET = 'file-src-2f-greet-2e-js';
/** The unit of work of "Work in a folder" on the sample project's `notes`. */
const NOTES = 'folder-notes';
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
  const root = example.temporaryRoot();
  if (root === undefined) throw new Error(`The example named no folder:\n${example.printed()}`);
  return root;
}

const launcher = (title: string) => page.getByRole('region', { name: title, exact: true });
const card = (key: string) => page.locator(`li.session[data-key="${key}"]`);
const terminal = () => page.locator('#terminal');

/** The texts of a select's options, the blank one left out. */
async function choicesOf(select: Locator): Promise<string[]> {
  return (await select.locator('option').allTextContents()).filter((text) => text !== 'Choose…');
}

/** Waits for a select of a launcher to offer exactly these choices. */
async function offers(select: Locator, choices: readonly string[]): Promise<void> {
  await expect.poll(() => choicesOf(select), { timeout: WAIT_MS }).toEqual(choices);
}

/** Fills a file launcher (Explain, Review) on one of the sample project's files and runs it. */
async function runOnFile(
  title: string,
  folder: string,
  file: string,
  { fresh = false } = {},
): Promise<Locator> {
  const form = launcher(title);
  await form.getByLabel('Folder').selectOption({ label: folder });
  await offers(form.getByLabel('File'), FILES[folder] ?? []);
  await form.getByLabel('File').selectOption({ label: file });
  await form.getByLabel('Start a fresh conversation').setChecked(fresh);
  await form.getByRole('button', { name: 'Run' }).click();
  return form.getByRole('status');
}

/** The files of each folder of the sample project, as the File field offers them. */
const FILES: Readonly<Record<string, readonly string[]>> = {
  'The app’s folder': ['README.md'],
  notes: ['ideas.md', 'todo.md'],
  src: ['farewell.js', 'greet.js'],
};

/** Waits for an operation's result: its action and reason, as the page shows them. */
async function settled(status: Locator, terms: string): Promise<void> {
  await status.getByText(new RegExp(`^${terms} → `)).waitFor();
}

/** Waits for a session's card to show a state, its reason with `ended`. */
async function inState(key: string, state: string): Promise<void> {
  await card(key).locator('.state').getByText(state, { exact: true }).waitFor();
}

/** A session's history as its card shows it: what each run or open did, oldest first. */
async function historyOf(key: string): Promise<string[]> {
  const entries = await card(key).locator('.history li').allTextContents();
  return entries
    .map(
      (entry) =>
        /— (\w+ of \w+) .*: (.+), in conversation/.exec(entry)?.slice(1).join(': ') ?? entry,
    )
    .reverse();
}

/** The rows of the mounted terminal's screen, as a person reads them. */
async function terminalRows(): Promise<string[]> {
  const rows = await terminal().locator('.xterm-rows > div').allInnerTexts();
  return rows.map((row) => row.replace(/\s+/g, ' ').trim());
}

/** The agent's input box, as the screen's last row that begins with its sign. */
async function inputBox(): Promise<string | undefined> {
  return (await terminalRows()).findLast((row) => row.startsWith('❯'));
}

/** Shows a session's terminal and waits for it to be open on the agent's screen. */
async function showTerminalOf(key: string): Promise<void> {
  await page.getByRole('button', { name: `Show the terminal of ${key}` }).click();
  await page.locator('#terminal-key').getByText(key, { exact: true }).waitFor();
  await page.locator('#terminal-status').getByText('(open)').waitFor();
  await expect.poll(inputBox, { timeout: WAIT_MS }).toBe('❯');
}

/** Gives the mounted terminal the keyboard, as a click would, without a click the agent could read. */
async function focusTerminal(): Promise<void> {
  await terminal().locator('textarea').focus();
}

/**
 * Records, at each key the person presses in the mounted terminal, the
 * terminal's status as the page shows it then.
 *
 * @returns What it recorded so far, each time it is called.
 */
async function recordStatusAtEachKey(): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const recorded: string[] = [];
    (globalThis as { statusAtKeys?: string[] }).statusAtKeys = recorded;
    document
      .getElementById('terminal')
      ?.addEventListener(
        'keydown',
        () => recorded.push(document.getElementById('terminal-status')?.textContent ?? ''),
        { capture: true },
      );
  });
  return () => page.evaluate(() => (globalThis as { statusAtKeys?: string[] }).statusAtKeys ?? []);
}

/** Types into the mounted terminal, as a person does, and waits for the input box to show it. */
async function typeInTerminal(text: string): Promise<void> {
  await terminal().click();
  await page.keyboard.type(text);
  await expect.poll(inputBox, { timeout: WAIT_MS }).toBe(`❯ ${text}`);
}

describe('the jobs console, against the scripted API', () => {
  it('opens on the printed link, the token leaves the address bar, and a launcher shows for each job', async () => {
    await page.goto(app.link);

    await page.getByText('Following the sessions.').waitFor();
    await page.getByText('No sessions yet').waitFor();
    expect(page.url()).not.toContain('#');
    expect(page.url()).not.toContain(new URL(app.link).hash.slice(1));
    await expect
      .poll(() => page.locator('section.job h3').allTextContents())
      .toEqual(['Explain a file', 'Review a file', 'Work in a folder', 'Ask anything']);
  });

  it('draws each field from the job’s schema: its label, its choices, its default, whether it is required', async () => {
    const explain = launcher('Explain a file');
    await offers(explain.getByLabel('Folder'), ['The app’s folder', 'notes', 'src']);
    expect(await choicesOf(explain.getByLabel('File'))).toEqual([]);
    expect(await choicesOf(explain.getByLabel('Detail'))).toEqual(['brief', 'thorough']);
    expect(await explain.getByLabel('Detail').locator('option:checked').textContent()).toBe(
      'brief',
    );
    expect(await explain.getByLabel('Folder').getAttribute('required')).not.toBeNull();
    expect(await explain.getByLabel('Detail').getAttribute('required')).toBeNull();
    await explain.getByText('One of the folder’s files.').waitFor();

    const ask = launcher('Ask anything');
    const suggested = ask.locator('datalist option');
    await expect
      .poll(() =>
        suggested.evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value)),
      )
      .toEqual(['the project', 'the notes', 'the code']);
    expect(await ask.getByLabel('Topic').getAttribute('list')).not.toBeNull();

    await launcher('Work in a folder')
      .getByText('No prompt: a run starts the agent for you to type in its terminal.')
      .waitFor();
  });

  it('reads a field’s choices again when a field before it changes', async () => {
    const explain = launcher('Explain a file');

    await explain.getByLabel('Folder').selectOption({ label: 'notes' });
    await offers(explain.getByLabel('File'), ['ideas.md', 'todo.md']);
    await explain.getByLabel('File').selectOption({ label: 'todo.md' });

    await explain.getByLabel('Folder').selectOption({ label: 'src' });
    await offers(explain.getByLabel('File'), ['farewell.js', 'greet.js']);
    expect(
      await explain.getByLabel('File').inputValue(),
      'a value no longer offered is cleared',
    ).toBe('');
  });

  it('runs a job: a session starts, goes idle with the answer, and its record has the run', async () => {
    const status = await runOnFile('Explain a file', 'src', 'greet.js');

    await settled(status, 'started');
    await inState(GREET, 'idle');
    expect(await card(GREET).locator('.states-seen').textContent()).toMatch(/busy → idle$/);
    expect(await card(GREET).locator('.last-answer').textContent()).toContain(SCRIPTED_ANSWER);
    await card(GREET).getByText('History (1)').click();
    await card(GREET)
      .getByText(/run of explain .*"file":"greet.js".*: started, in conversation/)
      .waitFor();
  });

  it('runs it again on the same file: the live session takes the prompt, and its record has the run', async () => {
    const status = await runOnFile('Explain a file', 'src', 'greet.js');

    await settled(status, 'sent');
    await inState(GREET, 'idle');
    await card(GREET).getByText('History (2)').waitFor();
    expect(await historyOf(GREET)).toEqual(['run of explain: started', 'run of explain: sent']);
  });

  it('refuses a value that is not among the field’s choices, and starts nothing', async () => {
    // The page's own client, through its import map: a run no form of the page can send.
    const refused = await page.evaluate(`
      import('@duongtdn/agent-cockpit/client').then(({ createCockpitClient }) =>
        createCockpitClient({ baseUrl: '/cockpit' })
          .run('explain', { folder: 'src', file: 'missing.js' })
          .then(() => 'run', (error) => error.code + ' ' + error.field),
      )
    `);

    expect(refused).toBe('not-a-choice file');
    expect(await page.locator('li.session').count()).toBe(1);
  });

  it('runs another job of the same key with other settings: the session restarts, its conversation resumed', async () => {
    const status = await runOnFile('Review a file', 'src', 'greet.js');

    await settled(status, 'resumed · settings-changed');
    await inState(GREET, 'idle');
    await card(GREET)
      .getByText(/run of review .*: resumed · settings-changed/)
      .waitFor();
    expect(await card(GREET).locator('.states-seen').textContent()).toContain('ended · restarted');
  });

  it('keeps a draft typed in the terminal through a send from the page', async () => {
    const draft = 'a draft kept aside';
    const prompt = 'Summarize it in one line.';
    await showTerminalOf(GREET);
    await typeInTerminal(draft);

    await card(GREET).getByLabel(`Prompt for ${GREET}`).fill(prompt);
    await card(GREET)
      .getByRole('button', { name: `Send to ${GREET}` })
      .click();

    await settled(card(GREET).getByRole('status'), 'sent');
    await inState(GREET, 'idle');
    await expect.poll(terminalRows, { timeout: WAIT_MS }).toContain(`❯ ${prompt}`);
    await expect.poll(inputBox, { timeout: WAIT_MS }).toBe(`❯ ${draft}`);
    expect(await card(GREET).getByLabel(`Prompt for ${GREET}`).inputValue()).toBe('');
  });

  it('holds the keys typed in the terminal while a send types, then passes them on after it, in order', async () => {
    const draft = 'a draft kept aside';
    const prompt = 'Say it once more.';
    const typedMeanwhile = ' and keys typed meanwhile';
    await expect.poll(inputBox, { timeout: WAIT_MS }).toBe(`❯ ${draft}`);
    const statusAtKeys = await recordStatusAtEachKey();

    await card(GREET).getByLabel(`Prompt for ${GREET}`).fill(prompt);
    await card(GREET)
      .getByRole('button', { name: `Send to ${GREET}` })
      .click();
    await page.locator('#terminal-status').getByText('(held)').waitFor();
    await focusTerminal();
    await page.keyboard.type(typedMeanwhile);

    await settled(card(GREET).getByRole('status'), 'sent');
    await page.locator('#terminal-status').getByText('(open)').waitFor();
    expect(await statusAtKeys()).toEqual([...typedMeanwhile].map(() => '(held)'));
    await expect.poll(terminalRows, { timeout: WAIT_MS }).toContain(`❯ ${prompt}`);
    await expect.poll(inputBox, { timeout: WAIT_MS }).toBe(`❯ ${draft}${typedMeanwhile}`);
    await inState(GREET, 'idle');
  });

  it('opens a session the agent left: its conversation resumed with no prompt', async () => {
    await terminal().click();
    // The draft goes: the input box takes `/exit` alone.
    await page.keyboard.press('Control+U');
    await typeInTerminal('/exit');
    await page.keyboard.press('Enter');
    await inState(GREET, 'ended · agent-exit');

    await page.getByRole('button', { name: `Open ${GREET}`, exact: true }).click();

    await settled(card(GREET).getByRole('status'), 'resumed');
    await inState(GREET, 'idle');
    await card(GREET)
      .getByText(/open of review .*: resumed, in conversation/)
      .waitFor();
  });

  it('opens it in a fresh conversation: the old one stays in the record', async () => {
    const before = await card(GREET).locator('.conversations').textContent();
    expect(before).toContain('before it: none');

    await page.getByRole('button', { name: `Open ${GREET} in a fresh conversation` }).click();

    await settled(card(GREET).getByRole('status'), 'started · fresh-on-request');
    await inState(GREET, 'idle');
    await card(GREET)
      .getByText(/open of review .*: started · fresh-on-request/)
      .waitFor();
    await card(GREET)
      .locator('.conversations')
      .getByText(/before it: \w{8}\.$/)
      .waitFor();
  });

  it('runs a job fresh from its launcher: a new conversation with the job’s prompt', async () => {
    const status = await runOnFile('Explain a file', 'src', 'greet.js', { fresh: true });

    await settled(status, 'started · fresh-on-request');
    await inState(GREET, 'idle');
    await card(GREET)
      .locator('.conversations')
      .getByText(/before it: \w{8}, \w{8}\.$/)
      .waitFor();
    expect(
      await launcher('Explain a file').getByLabel('Start a fresh conversation').isChecked(),
    ).toBe(false);
  });

  it('runs a job with no prompt: it resolves at idle, then has nothing to send or open', async () => {
    const work = launcher('Work in a folder');
    await offers(work.getByLabel('Folder'), ['The app’s folder', 'notes', 'src']);
    await work.getByLabel('Folder').selectOption({ label: 'notes' });

    await work.getByRole('button', { name: 'Run' }).click();
    await settled(work.getByRole('status'), 'started');
    expect(await work.getByRole('status').getAttribute('data-state')).toBe('idle');
    await inState(NOTES, 'idle');
    await showTerminalOf(NOTES);

    await work.getByRole('button', { name: 'Run' }).click();
    await settled(work.getByRole('status'), 'nothing-to-send');
    await page.getByRole('button', { name: `Open ${NOTES}`, exact: true }).click();
    await settled(card(NOTES).getByRole('status'), 'nothing-to-open');
  });

  it('takes a value of a field that only suggests, beside its suggestions', async () => {
    const ask = launcher('Ask anything');
    await ask.getByLabel('Topic').fill('the weather');
    await ask.getByLabel('Question').fill('Will it rain?');

    await ask.getByRole('button', { name: 'Run' }).click();

    await settled(ask.getByRole('status'), 'started');
    await inState('ask-the-20-weather', 'idle');
  });

  it('keeps two topics apart that differ only in their punctuation: each is a unit of work', async () => {
    const ask = launcher('Ask anything');
    await ask.getByLabel('Topic').fill('the-weather');
    await ask.getByLabel('Question').fill('Will it rain?');

    await ask.getByRole('button', { name: 'Run' }).click();

    await settled(ask.getByRole('status'), 'started');
    await inState('ask-the-2d-weather', 'idle');
    await inState('ask-the-20-weather', 'idle');
  });

  it('says which field a refused run’s arguments fail on, in the cockpit’s words', async () => {
    const ask = launcher('Ask anything');
    await ask.getByLabel('Topic').fill('?!');
    await ask.getByLabel('Question').fill('Will it rain?');

    await ask.getByRole('button', { name: 'Run' }).click();

    await ask
      .getByRole('status')
      .getByText('topic: Name a topic: at least one letter or digit.', { exact: true })
      .waitFor();
    expect(await ask.getByRole('status').getAttribute('data-error')).toBe('invalid-arguments');
  });

  it('works again when the page is reopened without the link’s fragment: the sessions, their records and the terminal', async () => {
    const reopened = page.url();
    expect(reopened).not.toContain('#');

    await page.goto('about:blank');
    await page.goto(reopened);

    await inState(GREET, 'idle');
    expect(await historyOf(GREET)).toEqual(
      expect.arrayContaining([
        'run of explain: started',
        'run of explain: sent',
        'run of review: resumed · settings-changed',
        'open of review: resumed',
        'open of review: started · fresh-on-request',
        'run of explain: started · fresh-on-request',
      ]),
    );
    await page.locator('#terminal-key').getByText(NOTES, { exact: true }).waitFor();
    await page.locator('#terminal-status').getByText('(open)').waitFor();
  });

  it('says why a terminal cannot be shown for a key in the address that is no key', async () => {
    const address = new URL(page.url());
    address.searchParams.set('session', 'Not a key');

    await page.goto(address.href);

    await page.locator('#terminal-key').getByText('Not a key', { exact: true }).waitFor();
    await page.locator('#terminal-status').getByText('The terminal needs a session key.').waitFor();
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
