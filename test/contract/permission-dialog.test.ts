import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readInputBoxView } from '../../src/claude-code/screen-reading.ts';
import { toolUse, turn } from '../support/fake-api/index.ts';
import { startContractAgent, submitPrompt } from './harness.ts';

/**
 * What becomes of keys that reach the agent as a tool's permission dialog
 * is drawn: a person's keys typed once the hooks tell of the ask can come
 * before the dialog shows, and must answer nothing.
 */

const DIALOG = 'Do you want';

for (const typed of ['typed early', '1']) {
  it(`127 — Keys typed the moment PermissionRequest arrives (${JSON.stringify(typed)}), before the dialog shows: the dialog shows unanswered, the tool not run (a "1" approves nothing); answered with Esc, it leaves the input box holding what was typed or nothing (the dialog may take and drop keys that reach it as it shows), never anything else`, async () => {
    const agent = await startContractAgent();
    const file = join(agent.workFolder, 'made.txt');
    agent.api.script(turn(toolUse('Write', { file_path: file, content: 'x\n' })), turn('Done.'));
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await submitPrompt(agent, session, 'write it');

    await agent.hook('PermissionRequest');
    await session.type(typed);
    const shown = await agent.eventually(async () => {
      const screen = await session.screen();
      expect(screen.includes(DIALOG) || existsSync(file)).toBe(true);
      return screen;
    });
    const ranBeforeTheAnswer = existsSync(file);
    await session.press('Escape');
    await agent.eventually(async () => expect(await session.screen()).not.toContain(DIALOG));
    const box = await agent.eventually(async () => {
      const view = readInputBoxView(await session.screen());
      expect(view).toBeDefined();
      return view?.text.trimEnd();
    });

    expect(shown).toContain(DIALOG);
    expect(ranBeforeTheAnswer).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect([typed, '']).toContain(box);
  });
}
