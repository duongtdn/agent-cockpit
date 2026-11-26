import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type RealAgentRunner, startRealAgentRunner } from '../support/real-agent/runner.ts';

const LOOPBACK = 'http://127.0.0.1:9';
const SOME_SESSION = '0c9a3d4e-0000-4000-8000-000000000000';

let runner: RealAgentRunner | undefined;

afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

describe('the runner of the real agent', () => {
  it("does not start with an API that is not on the loopback: Anthropic's is never reached", async () => {
    for (const apiBaseUrl of ['https://api.anthropic.com', 'http://127.0.0.1\\@example.com']) {
      await expect(startRealAgentRunner({ apiBaseUrl, settings: {} })).rejects.toThrow(
        /ANTHROPIC_BASE_URL/,
      );
    }
  });

  it('refuses to launch, new or resumed, with settings that would send the agent elsewhere', async () => {
    runner = await startRealAgentRunner({
      apiBaseUrl: LOOPBACK,
      settings: { env: { ANTHROPIC_BASE_URL: 'https://example.com' } },
    });

    await expect(runner.startNew({ prompt: 'hello' })).rejects.toThrow(/settings.*"env"/);
    await expect(runner.resume(SOME_SESSION)).rejects.toThrow(/settings.*"env"/);
  });

  it('removes its temporary root when closed, and may be closed twice', async () => {
    runner = await startRealAgentRunner({ apiBaseUrl: LOOPBACK, settings: {} });
    expect(existsSync(runner.workFolder)).toBe(true);
    expect(runner.workFolder.startsWith(`${runner.root}/`)).toBe(true);

    await runner.close();
    await runner.close();

    expect(existsSync(runner.root)).toBe(false);
    expect(runner.leftOutsideRoot()).toEqual([]);
  });
});
