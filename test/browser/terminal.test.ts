import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventually } from '../support/eventually.ts';
import { startTerminalPage, type TerminalPage } from '../support/terminal-page.ts';
import { type AcceptedSocket, startWireServer, type WireServer } from '../support/wire-server.ts';

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';
const claudeCodeKeys = JSON.stringify({
  type: 'keys',
  rules: [{ key: 'Enter', modifiers: ['shift'], send: '\x1b\r' }],
});

let browser: Browser;
let pageServer: TerminalPage;
let server: WireServer;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  pageServer = await startTerminalPage();
});

afterAll(async () => {
  await browser?.close();
  await pageServer?.close();
});

beforeEach(async () => {
  server = await startWireServer();
  // Headless Chromium grants no clipboard by default; a person's browser grants writing on 127.0.0.1.
  context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
});

afterEach(async () => {
  await context.close();
  await server.close();
});

/** A socket the page opened, and what the server received on it. */
interface Attached {
  readonly accepted: AcceptedSocket;
  readonly messages: (string | Buffer)[];
  /** The binary messages, as text: what was typed. */
  typed(): string;
}

/**
 * What tmux sends first to a terminal attached with `mouse on`: it asks for
 * mouse reports (buttons, drags, SGR encoding), so a plain drag goes to tmux
 * or to the agent, never to xterm.js's own selection.
 */
const MOUSE_REPORTS_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

/** Opens the page, accepts its socket, sends the driver's keys and some output. */
async function openAttached(
  output = `${MOUSE_REPORTS_ON}The answer: copy these words.\r\n`,
): Promise<Attached> {
  await page.goto(pageServer.url({ baseUrl: server.baseUrl, key: 'explain-a', token }));
  const accepted = await server.nextSocket();
  const { messages } = accepted;
  await page.waitForFunction(() =>
    (window as unknown as { statuses: string[] }).statuses.includes('open'),
  );
  accepted.socket.send(claudeCodeKeys);
  accepted.socket.send(Buffer.from(output, 'utf8'));
  await page.getByText('copy these words').waitFor();
  return {
    accepted,
    messages,
    typed: () =>
      Buffer.concat(messages.filter((message) => Buffer.isBuffer(message))).toString('utf8'),
  };
}

const sizes = (attached: Attached): unknown[] =>
  attached.messages.filter((message) => typeof message === 'string').map((m) => JSON.parse(m));

const clipboard = (): Promise<string> => page.evaluate(() => navigator.clipboard.readText());

/** The middle of a cell of the terminal, on the page, at the size last sent. */
async function cell(
  attached: Attached,
  column: number,
  row: number,
): Promise<{ x: number; y: number }> {
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box === null) throw new Error('The terminal is not on the page.');
  const size = sizes(attached).at(-1) as { columns: number; rows: number };
  return {
    x: box.x + (column + 0.5) * (box.width / size.columns),
    y: box.y + (row + 0.5) * (box.height / size.rows),
  };
}

describe('in a browser', () => {
  let attached: Attached;

  beforeEach(async () => {
    attached = await openAttached();
  });

  it("sends first the size xterm.js fits to the element, and shows the session's output", async () => {
    const [first] = sizes(attached) as { type: string; columns: number; rows: number }[];

    expect(first?.type).toBe('resize');
    // 800 × 400 pixels of a 15-pixel font: far more than one cell, far fewer than the pixels.
    expect(first?.columns).toBeGreaterThan(40);
    expect(first?.columns).toBeLessThan(200);
    expect(first?.rows).toBeGreaterThan(10);
    expect(first?.rows).toBeLessThan(60);
    expect(attached.accepted.token).toBe(token);
  });

  it("sends a new size when the app changes the element's", async () => {
    const [first] = sizes(attached) as { columns: number; rows: number }[];

    await page.evaluate(() => {
      const element = document.getElementById('terminal') as HTMLElement;
      element.style.width = '400px';
      element.style.height = '200px';
    });

    await eventually(() => {
      const last = sizes(attached).at(-1) as { columns: number; rows: number };
      expect(last.columns).toBeLessThan((first?.columns ?? 0) * 0.6);
      expect(last.rows).toBeLessThan((first?.rows ?? 0) * 0.6);
    });
  });

  it('sends typed keys, and Shift+Enter as the driver says: ESC CR, not CR', async () => {
    await page.locator('.xterm-helper-textarea').focus();

    await page.keyboard.type('hi é');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Enter');

    await eventually(() => expect(attached.typed()).toBe('hi é\x1b\r\r'));
  });

  it('puts in the clipboard what the session copies (OSC 52)', async () => {
    attached.accepted.socket.send(Buffer.from('\x1b]52;;Y29weSB0aGVzZSB3b3Jkcw==\x07'));

    await eventually(async () => expect(await clipboard()).toBe('copy these words'));
  });

  it('copies a Shift+drag selection with Ctrl+C, and sends nothing to the session', async () => {
    await page.evaluate(() => navigator.clipboard.writeText('before'));
    const from = await cell(attached, 12, 0);
    const to = await cell(attached, 28, 0);

    await page.keyboard.down('Shift');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.keyboard.press('Control+c');

    await eventually(async () => expect(await clipboard()).toBe('copy these words'));
    // A key typed after: the Ctrl+C, had it been sent, would be before it.
    await page.keyboard.type('x');
    await eventually(() => expect(attached.typed()).toBe('x'));
  });

  it('sends Ctrl+C to the session when nothing is selected', async () => {
    await page.locator('.xterm-helper-textarea').focus();

    await page.keyboard.press('Control+c');

    await eventually(() => expect(attached.typed()).toBe('\x03'));
  });

  it('is ended when the server closes with the ended code', async () => {
    attached.accepted.socket.close(4000);

    await page.waitForFunction(() =>
      (window as unknown as { statuses: string[] }).statuses.includes('ended'),
    );
    expect(
      await page.evaluate(() => (window as unknown as { statuses: string[] }).statuses),
    ).toEqual(['connecting', 'open', 'ended']);
  });
});
