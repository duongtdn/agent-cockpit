import { describe, expect, it } from 'vitest';
import { type ContractAgent, startContractAgent } from '../contract/harness.ts';

/** Starts the surroundings of a contract test, and hands over what the test's end would run. */
async function startAgent(): Promise<{ agent: ContractAgent; finish: () => Promise<void> }> {
  let finish: (() => Promise<void>) | undefined;
  const agent = await startContractAgent((whenFinished) => {
    finish = whenFinished;
  });
  if (finish === undefined)
    throw new Error('The harness registered nothing for the end of the test.');
  return { agent, finish };
}

/** Sends the API's double a conversation request, as an agent would on a prompt. */
function converse(agent: ContractAgent, prompt: string): Promise<Response> {
  return fetch(`${agent.api.baseUrl}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({
      model: 'claude-test',
      tools: [{ name: 'Bash' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
}

const UNSCRIPTED = /no scripted answer.*\n.*last user message: "a surprise"/;

describe('the harness of the contract tests', () => {
  it('fails a test at its end when a conversation request had no scripted answer, naming it', async () => {
    const { agent, finish } = await startAgent();
    await converse(agent, 'a surprise');

    await expect(finish()).rejects.toThrow(UNSCRIPTED);
  });

  it('ends a test whose requests were all scripted with nothing to say', async () => {
    const { finish } = await startAgent();

    await expect(finish()).resolves.toBeUndefined();
  });

  it('closes everything at the end of a test, whatever the checks find', async () => {
    const { agent, finish } = await startAgent();
    await converse(agent, 'a surprise');

    await finish().catch(() => undefined);

    await expect(converse(agent, 'anyone there?')).rejects.toThrow();
  });

  it('fails the wait for a hook at once when an unscripted request arrives', async () => {
    const { agent, finish } = await startAgent();
    const failed = expect(agent.hook('Stop')).rejects.toThrow(UNSCRIPTED);

    await converse(agent, 'a surprise');

    await failed;
    await finish().catch(() => undefined);
  });

  it('fails a wait for what a session shows at once when an unscripted request arrived', async () => {
    const { agent, finish } = await startAgent();
    await converse(agent, 'a surprise');
    let tries = 0;

    const wait = agent.eventually(() => {
      tries += 1;
      throw new Error('not yet');
    });

    await expect(wait).rejects.toThrow(UNSCRIPTED);
    expect(tries).toBe(0);
    await finish().catch(() => undefined);
  });
});
