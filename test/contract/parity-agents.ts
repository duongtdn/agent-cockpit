import { expect, type TaskMeta } from 'vitest';
import type { AgentSession } from '../support/agent-session.ts';
import { startFakeAgentRunner } from '../support/fake-agent/runner.ts';
import type { Turn } from '../support/fake-agent/script.ts';
import { holdTasks, releaseTasks } from '../support/fake-agent/tasks.ts';
import type { FakeApi } from '../support/fake-api/index.ts';
import { startHookReceiver } from '../support/hooks/hook-receiver.ts';
import { apiAnswersFor, subagentAnswersFor } from '../support/parity/api-answers.ts';
import { comparable, type ObservedHook } from '../support/parity/hook-comparison.ts';
import type { RecipePiece } from '../support/real-agent/environment.ts';
import { runAll } from '../support/run-all.ts';
import {
  type DrivenAgent,
  drivenAgent,
  NO_ASK_FOR_SHELL_COMMANDS,
  sessionSettings,
  startContractAgent,
  type WhenFinished,
} from './harness.ts';

/** An agent, real or fake, as a scenario drives it: the scenario cannot tell which. */
export interface ParityAgent extends DrivenAgent {
  /**
   * Waits until a turn stays busy: the model is awaited, and does not
   * answer. Nothing a hook or a transcript says marks that moment.
   */
  staysBusy(session: AgentSession): Promise<void>;
  /**
   * Lets the background task the script started do its work: until then
   * its subagent waits, on either agent, as one whose model has not answered.
   */
  releaseTask(): Promise<void>;
}

/** Something to play once on each agent, for what their hooks said to be compared. */
export interface Scenario {
  /**
   * What the agent does with each prompt, as a script of the fake agent's.
   * The real agent's API is scripted from it.
   */
  readonly script: readonly Turn[];
  /** The `permissions` of the sessions' settings; by default every shell command runs without an ask. */
  readonly permissions?: object;
  /**
   * The pieces of the start-up recipe left out of both agents'
   * configuration, each for the dialog it spares; none by default.
   */
  readonly leftOutOfRecipe?: readonly RecipePiece[];
  /**
   * Drives the agent: launches, prompts, keys, answers to its hooks, and
   * the end. It awaits every hook it expects, so that all of them arrived
   * when it returns.
   */
  play(agent: ParityAgent): Promise<void>;
}

/** What a receiver got of each agent, made comparable: the two agree when the lists are equal. */
export interface BothAgentsHooks {
  readonly real: ObservedHook[];
  readonly fake: ObservedHook[];
}

/**
 * Plays a scenario on the real agent and on the fake agent, side by side,
 * each with a receiver, folders and a tmux socket of its own, and ends
 * both with the test.
 *
 * @param scenario - See {@link Scenario}.
 * @param whenFinished - Registers the test's end: the test's own, since scenarios are played alongside each other.
 * @param meta - The test's own metadata, for the same reason.
 * @returns What each agent's hooks said, for `expect(fake).toEqual(real)`.
 * @throws Error as every wait of the contract suite's, when an agent does
 * not do what the scenario awaits: for the fake agent, with the reason it
 * shows on its last screen.
 */
export async function hooksOfBothAgents(
  scenario: Scenario,
  whenFinished: WhenFinished,
  meta: TaskMeta,
): Promise<BothAgentsHooks> {
  const real = await realAgent(scenario, whenFinished, meta);
  // The fake agent is told the real one's API, which a failure names: it never calls it.
  const fake = await fakeAgent(scenario, real.api.baseUrl, whenFinished, meta);
  const [realHooks, fakeHooks] = await Promise.all([
    played(scenario, real),
    played(scenario, fake),
  ]);
  return { real: realHooks, fake: fakeHooks };
}

/** Plays a scenario on an agent, and gives what its receiver got since. */
async function played(scenario: Scenario, agent: ParityAgent): Promise<ObservedHook[]> {
  const launched: AgentSession[] = [];
  const remembered = async (launching: Promise<AgentSession>) => {
    const session = await launching;
    launched.push(session);
    return session;
  };
  await scenario.play({
    ...agent,
    startNew: (options) => remembered(agent.startNew(options)),
    resume: (sessionId, options) => remembered(agent.resume(sessionId, options)),
  });
  if (launched.length === 0) throw new Error('The scenario launched no session.');
  const sessionIds = [...new Set(launched.map((session) => session.id))];
  return comparable(agent.hooks.received, { sessionIds, workFolder: agent.workFolder });
}

/**
 * The real agent never tries a request again: a failure the scripted API
 * answers ends the turn at once, as the fake agent plays the end of the
 * retries.
 */
const NO_RETRIES = { CLAUDE_CODE_MAX_RETRIES: '0' };

async function realAgent(
  scenario: Scenario,
  whenFinished: WhenFinished,
  meta: TaskMeta,
): Promise<ParityAgent & { readonly api: FakeApi }> {
  const agent = await startContractAgent({
    ...permissionsOf(scenario),
    runner: { leftOutOfRecipe: scenario.leftOutOfRecipe ?? [], variables: NO_RETRIES },
    whenFinished,
    meta,
  });
  agent.api.script(...apiAnswersFor(scenario.script));
  for (const { prompt, answers } of subagentAnswersFor(scenario.script)) {
    agent.api.scriptConversation(prompt, ...answers);
  }
  let tasksReleased = 0;
  return {
    ...agent,
    staysBusy: async () => {
      await agent.waitFor('the request the API holds', agent.api.heldRequest());
    },
    // A scenario with a task holds no other request: the task's are the only ones held.
    releaseTask: async () => {
      tasksReleased += 1;
      (
        await agent.waitFor('the task the API holds', agent.api.heldRequest(tasksReleased))
      ).release();
    },
  };
}

async function fakeAgent(
  scenario: Scenario,
  apiBaseUrl: string,
  whenFinished: WhenFinished,
  meta: TaskMeta,
): Promise<ParityAgent> {
  // Closed last started first: the sessions end while their hooks still have somewhere to go.
  const closers: (() => Promise<void>)[] = [];
  whenFinished(() => runAll(closers.reverse()));
  const hooks = await startHookReceiver();
  closers.push(() => hooks.close());
  const launcher = await startFakeAgentRunner({
    settings: sessionSettings(hooks, permissionsOf(scenario).permissions),
    script: scenario.script,
    leftOutOfRecipe: scenario.leftOutOfRecipe ?? [],
    apiBaseUrl,
  });
  closers.push(() => launcher.close());
  holdTasks(launcher.workFolder);
  const agent = drivenAgent({ hooks, launcher, meta });
  return {
    ...agent,
    staysBusy: async (session) => {
      await agent.eventually(async () => expect(await session.screen()).toContain(STAYS_BUSY));
    },
    releaseTask: async () => releaseTasks(launcher.workFolder),
  };
}

/** What the fake agent's screen shows while a turn stays busy. */
const STAYS_BUSY = 'step: stay-busy';

function permissionsOf(scenario: Scenario): { readonly permissions: object } {
  return { permissions: scenario.permissions ?? NO_ASK_FOR_SHELL_COMMANDS };
}
