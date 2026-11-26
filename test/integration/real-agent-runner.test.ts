import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type RealAgentRunner, startRealAgentRunner } from '../support/real-agent/runner.ts';

let runner: RealAgentRunner | undefined;

afterEach(async () => {
  await runner?.close();
});

describe('the runner of the real agent', () => {
  it("refuses to launch, new or resumed, with an API that is not on the loopback: Anthropic's is never reached", async () => {
    runner = await startRealAgentRunner({ apiBaseUrl: 'https://api.anthropic.com', settings: {} });

    await expect(runner.startNew({ prompt: 'hello' })).rejects.toThrow(/ANTHROPIC_BASE_URL/);
    await expect(runner.resume('0c9a3d4e-0000-4000-8000-000000000000')).rejects.toThrow(
      /ANTHROPIC_BASE_URL/,
    );
  });

  it('removes its temporary root when closed, and may be closed twice', async () => {
    runner = await startRealAgentRunner({ apiBaseUrl: 'http://127.0.0.1:9', settings: {} });
    expect(existsSync(runner.workFolder)).toBe(true);

    await runner.close();
    await runner.close();

    expect(existsSync(dirname(runner.workFolder))).toBe(false);
  });
});
