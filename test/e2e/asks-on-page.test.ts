import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameTrue, eventually } from '../support/eventually.ts';
import { type ExampleApp, startExampleApp } from '../support/example-app.ts';
import { PATIENCE, POLL } from '../support/patience.ts';

/**
 * "Asks on the page" end to end, as a person uses it: the example started
 * as its DEMO.md says (the pinned agent against the scripted API), a real
 * Chromium on its link, no terminal in the page. What only this level
 * shows: the built package, the client's socket and the page together, an
 * ask drawn and answered there, and an answer given in the session's own
 * terminal told there. The second test goes on from where the first left
 * the session.
 */

/** The session both tests run the job "Create a file" on: its key, whatever the file. */
const CREATE = 'create';
/** What the agent's permission dialog says, in its terminal. */
const PERMISSION_DIALOG = 'Do you want to proceed?';
/** What the scripted agent answers once its command ran. */
const COMMAND_RAN = 'Done: the command ran.';
/** How many times a key is pressed on a dialog that shows nothing of it. */
const DIALOG_KEY_PRESSES = 3;
/** Shorter than the test's timeout, so that a failed wait says what it waited for. */
const WAIT_MS = PATIENCE.exampleApp;

let app: ExampleApp;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  app = await startExampleApp('asks-on-page', ['--port', '0']);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(WAIT_MS);
});

afterAll(async () => {
  await browser?.close();
  if (app === undefined) return;
  const exitCode = await app.stop();
  expect(exitCode, app.printed()).toBe(0);
  expect(existsSync(temporaryRoot()), 'its temporary folder is removed').toBe(false);
});

/** The folder the example says its scripted agent keeps everything in. */
function temporaryRoot(): string {
  const root = app.temporaryRoot();
  if (root === undefined) throw new Error(`The example named no folder:\n${app.printed()}`);
  return root;
}

const pendingAsk = (key: string) => page.locator(`#pending li.ask[data-key="${key}"]`);
const settledAsk = (id: string) => page.locator(`#settled li[data-id="${id}"]`);
const sessionRow = (key: string) => page.locator(`#sessions tr[data-key="${key}"]`);

/** Runs "Create a file" on a file, as a person fills the form and presses its button. */
async function createFile(file: string): Promise<void> {
  await page.getByRole('textbox', { name: 'File' }).fill(file);
  await page.getByRole('button', { name: 'Create it', exact: true }).click();
}

/** Waits for a session's row to show a state. */
async function inState(key: string, state: string): Promise<void> {
  await sessionRow(key).locator('.state').getByText(state, { exact: true }).waitFor();
}

/** The id an ask's item carries: the cockpit's, which its settlement names. */
async function idOf(ask: Locator): Promise<string> {
  const id = await ask.getAttribute('data-id');
  if (id === null) throw new Error('The ask shows no id.');
  return id;
}

/** Runs tmux on the socket the example's cockpit runs its sessions on, under its scripted agent's folder. */
function tmux(...args: string[]): string {
  const socket = join(
    temporaryRoot(),
    'tmux',
    `tmux-${userInfo().uid}`,
    'agent-cockpit-asks-on-page',
  );
  return execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
}

/** What a session's terminal shows. */
function screenOf(key: string): string {
  return tmux('capture-pane', '-p', '-t', key);
}

/**
 * Answers the permission dialog in a session's terminal with its first
 * option, "Yes", as a person at the terminal presses Enter: once the dialog
 * shows, and again only when a whole scaled patience for its answer passed
 * with it still shown (a dialog was seen to drop a key pressed as it showed).
 */
async function answerYesInTerminal(key: string): Promise<void> {
  await eventually(() => expect(screenOf(key)).toContain(PERMISSION_DIALOG), undefined, WAIT_MS);
  for (let presses = 1; presses <= DIALOG_KEY_PRESSES; presses++) {
    tmux('send-keys', '-t', key, 'Enter');
    const answered = () => !screenOf(key).includes(PERMISSION_DIALOG);
    if (await cameTrue(answered, PATIENCE.dialogAnswered, POLL.screen)) return;
  }
  throw new Error(`The dialog did not take Enter:\n${screenOf(key)}`);
}

describe('asks on the page, against the scripted API', () => {
  it('shows the permission the agent asks, its tool, input and description; Allow lets the turn go on, the ask settled by app', async () => {
    await page.goto(app.link);
    await page.getByText('Following the sessions and their asks.').waitFor();
    await page.getByText('Nothing asked.').waitFor();

    await createFile('allowed.txt');

    const ask = pendingAsk(CREATE);
    await ask.waitFor();
    await inState(CREATE, 'waiting');
    expect(await ask.getAttribute('data-answerable')).toBe('app');
    expect(await ask.locator('.tool').textContent()).toBe('Bash');
    expect(JSON.parse((await ask.locator('.input').textContent()) ?? '')).toEqual({
      command: 'touch allowed.txt',
      description: 'Create the empty file allowed.txt',
    });
    expect(await ask.locator('.description').textContent()).toBe(
      'Create the empty file allowed.txt',
    );
    const id = await idOf(ask);

    await ask.getByRole('button', { name: 'Allow', exact: true }).click();

    await settledAsk(id).waitFor();
    expect(await settledAsk(id).locator('.by').textContent()).toBe('app');
    await inState(CREATE, 'idle');
    expect(await sessionRow(CREATE).locator('.last-answer').textContent()).toContain(COMMAND_RAN);
    expect(await pendingAsk(CREATE).count()).toBe(0);
  });

  it('shows a permission answered in the session’s terminal as settled by terminal', async () => {
    await createFile('in-terminal.txt');
    const ask = pendingAsk(CREATE);
    await ask.waitFor();
    const id = await idOf(ask);

    await answerYesInTerminal(CREATE);

    await settledAsk(id).waitFor();
    expect(await settledAsk(id).locator('.by').textContent()).toBe('terminal');
    await expect.poll(() => pendingAsk(CREATE).count(), { timeout: WAIT_MS }).toBe(0);
    await inState(CREATE, 'idle');
    expect(await sessionRow(CREATE).locator('.last-answer').textContent()).toContain(COMMAND_RAN);
  });
});
