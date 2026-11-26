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
  /**
   * Keeps what the scenario saw of the agent beside its hooks, to compare
   * with what it saw of the other: what the driver reads of a screen, what
   * a transcript records.
   *
   * @param what - What it is, the same on both agents.
   * @param value - What was seen.
   */
  observe(what: string, value: unknown): void;
}

/** One thing a scenario saw of an agent beside its hooks. */
export interface Observation {
  readonly what: string;
  readonly value: unknown;
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

/** What a scenario saw of one agent: its hooks, made comparable, and what it observed besides. */
export interface Played {
  readonly hooks: ObservedHook[];
  readonly observed: Observation[];
}

/** What a scenario saw of each agent: the two agree when they are equal. */
export interface BothAgentsPlayed {
  readonly real: Played;
  readonly fake: Played;
}

/**
 * Plays a scenario on the real agent and on the fake agent, side by side,
 * each with a receiver, folders and a tmux socket of its own, and ends
 * both with the test.
 *
 * @param scenario - See {@link Scenario}.
 * @param whenFinished - Registers the test's end: the test's own, since scenarios are played alongside each other.
 * @param meta - The test's own metadata, for the same reason.
 * @returns What each agent's hooks said, and what the scenario observed of
 * it, for `expect(fake).toEqual(real)`.
 * @throws Error as every wait of the contract suite's, when an agent does
 * not do what the scenario awaits: for the fake agent, with the reason it
 * shows on its last screen.
 */
export async function hooksOfBothAgents(
  scenario: Scenario,
  whenFinished: WhenFinished,
  meta: TaskMeta,
): Promise<BothAgentsPlayed> {
  const real = await realAgent(scenario, whenFinished, meta);
  // The fake agent is told the real one's API, which a failure names: it never calls it.
  const fake = await fakeAgent(scenario, real.api.baseUrl, whenFinished, meta);
  const [realPlayed, fakePlayed] = await Promise.all([
    played(scenario, real),
    played(scenario, fake),
  ]);
  return { real: realPlayed, fake: fakePlayed };
}

/** Plays a scenario on an agent, and gives what its receiver got since and what the scenario observed. */
async function played(scenario: Scenario, agent: UnplayedAgent): Promise<Played> {
  const observed: Observation[] = [];
  const launched: AgentSession[] = [];
  const remembered = async (launching: Promise<AgentSession>) => {
    const session = await launching;
    launched.push(session);
    return session;
  };
  await scenario.play({
    ...agent,
    observe: (what, value) => void observed.push({ what, value }),
    startNew: (options) => remembered(agent.startNew(options)),
    resume: (sessionId, options) => remembered(agent.resume(sessionId, options)),
  });
  if (launched.length === 0) throw new Error('The scenario launched no session.');
  const sessionIds = [...new Set(launched.map((session) => session.id))];
  const hooks = comparable(agent.hooks.received, { sessionIds, workFolder: agent.workFolder });
  return { hooks, observed };
}

/**
 * The real agent never tries a request again: a failure the scripted API
 * answers ends the turn at once, as the fake agent plays the end of the
 * retries.
 */
const NO_RETRIES = { CLAUDE_CODE_MAX_RETRIES: '0' };

/** An agent as made, before a play gives it somewhere to keep what is observed. */
type UnplayedAgent = Omit<ParityAgent, 'observe'>;

async function realAgent(
  scenario: Scenario,
  whenFinished: WhenFinished,
  meta: TaskMeta,
): Promise<UnplayedAgent & { readonly api: FakeApi }> {
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
): Promise<UnplayedAgent> {
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
