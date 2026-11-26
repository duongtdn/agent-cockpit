import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ContractAgent, startContractAgent } from '../contract/harness.ts';

/** Starts the surroundings of a contract test, and hands over what the test's end would run. */
async function startAgent(
  patienceMs?: number,
): Promise<{ agent: ContractAgent; finish: () => Promise<void> }> {
  let finish: (() => Promise<void>) | undefined;
  const agent = await startContractAgent({
    whenFinished: (whenFinished) => {
      finish = whenFinished;
    },
    ...(patienceMs === undefined ? {} : { patienceMs }),
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
/** A conversation the agent has none of: resumed on it, the agent says so and exits. */
const NO_SUCH_SESSION = '0c9a3d4e-0000-4000-8000-000000000000';
const never = new Promise<never>(() => {});

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

  it('closes the rest when something fails to close, and reports every failure', async () => {
    const { agent, finish } = await startAgent();
    const closeApi = agent.api.close;
    agent.api.close = async () => {
      await closeApi();
      throw new Error('the API could not close');
    };
    agent.hooks.close = () => Promise.reject(new Error('the receiver could not close'));
    await converse(agent, 'a surprise');

    const finished = finish();

    await expect(finished).rejects.toThrow(/the receiver could not close/);
    await expect(finished).rejects.toThrow(/the API could not close/);
    await expect(finished).rejects.toThrow(UNSCRIPTED);
    expect(existsSync(agent.workFolder)).toBe(false);
  });

  it('fails a test at its end when the agent asked for a path the double does not know', async () => {
    const { agent, finish } = await startAgent();
    await fetch(`${agent.api.baseUrl}/v1/files`);

    await expect(finish()).rejects.toThrow(/does not know.*\n.*GET \/v1\/files/);
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

  it('fails any wait at once when an unscripted request arrives', async () => {
    const { agent, finish } = await startAgent();
    const failed = expect(agent.waitFor('a held request', never)).rejects.toThrow(UNSCRIPTED);

    await converse(agent, 'a surprise');

    await failed;
    await finish().catch(() => undefined);
  });

  it('fails a wait that lasts too long, saying what it waited for and which hooks came', async () => {
    const { agent, finish } = await startAgent(30);

    await expect(agent.waitFor('a held request to end', never)).rejects.toThrow(
      /Waited 30 ms for a held request to end\. Hooks received: none\./,
    );
    await expect(agent.hook('Stop')).rejects.toThrow(/Waited 30 ms for a Stop hook\./);
    await finish();
  });

  it('gives what a wait was for when it comes in time', async () => {
    const { agent, finish } = await startAgent();

    expect(await agent.waitFor('an answer', Promise.resolve('here'))).toBe('here');
    await finish();
  });

  it('fails every wait at once when a session is gone that the test did not end, saying so', async () => {
    const { agent, finish } = await startAgent();
    const GONE = /The session agent-1 is gone: its agent exited/;

    await agent.resume(NO_SUCH_SESSION);

    await expect(agent.hook('SessionStart')).rejects.toThrow(GONE);
    await expect(agent.waitFor('a held request', never)).rejects.toThrow(GONE);
    await expect(agent.eventually(() => expect(1).toBe(2))).rejects.toThrow(GONE);
    await finish();
  });
});
