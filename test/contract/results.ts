/** The Enters one submit pressed before the one the agent took. */
export interface LostEnters {
  /** The text submitted. */
  readonly prompt: string;
  /** How many Enters the agent lost: pressed while the text stayed in the input box. */
  readonly lost: number;
}

declare module 'vitest' {
  interface TaskMeta {
    /** What a test's submits lost, for the run's results; absent when they lost nothing. */
    lostEnters?: LostEnters[];
  }
}

/** Enters lost in one test of a run. */
export interface TestLostEnters extends LostEnters {
  /** The test's title. */
  readonly test: string;
}

/** How a behavior's test ended. */
export type BehaviorOutcome = 'pass' | 'fail';

/** One behavior of the agent, as one run of the contract suite found it. */
export interface BehaviorResult {
  /** The behavior's number in the list of what the driver relies on. */
  readonly number: number;
  /** The behavior, as its test states it. */
  readonly title: string;
  readonly result: BehaviorOutcome;
}

/** What a run of the contract suite found, for one version of the agent. */
export interface ContractResults {
  readonly agent: 'claude-code';
  /** The version the pinned binary gave for itself. */
  readonly agentVersion: string;
  /** When the run ended, as an ISO 8601 date and time. */
  readonly date: string;
  /** The behaviors tested, by number. */
  readonly behaviors: readonly BehaviorResult[];
  /**
   * Every Enter the agent lost in the run, in any test, behavior or not: a
   * lost Enter fails no test, since the driver absorbs it, but shows here.
   */
  readonly lostEnters: readonly TestLostEnters[];
}

/** A test as the runner reports it, as far as the results need it. */
export interface FinishedTest {
  readonly name: string;
  /** The runner's word for the outcome: `passed`, `failed`, or one for a test that did not run. */
  readonly state: string;
  /** What its submits lost, as the test noted it. */
  readonly lostEnters?: readonly LostEnters[];
}

/** A behavior's test is titled with its number, a dash, and the behavior. */
const BEHAVIOR_TITLE = /^(\d+) — (.+)$/;

const OUTCOMES: Readonly<Record<string, BehaviorOutcome>> = { passed: 'pass', failed: 'fail' };

/**
 * Reads the behaviors' results off the tests of a run. A test whose title
 * does not begin with a behavior's number is not a behavior's, and a test
 * that did not run says nothing about its behavior: both are left out.
 *
 * @param tests - The tests of the run, in any order.
 * @returns The results, by number.
 */
export function behaviorResults(tests: readonly FinishedTest[]): BehaviorResult[] {
  return tests
    .flatMap((test) => {
      const [, number, title] = BEHAVIOR_TITLE.exec(test.name) ?? [];
      const result = OUTCOMES[test.state];
      if (number === undefined || title === undefined || result === undefined) return [];
      return [{ number: Number(number), title, result }];
    })
    .sort((one, other) => one.number - other.number);
}

/**
 * Builds the document a run of the contract suite leaves.
 *
 * @param agentVersion - The agent's version, as its binary gave it.
 * @param endedAt - When the run ended.
 * @param tests - The tests of the run.
 * @returns The document, to write as JSON.
 */
export function contractResults(
  agentVersion: string,
  endedAt: Date,
  tests: readonly FinishedTest[],
): ContractResults {
  return {
    agent: 'claude-code',
    agentVersion,
    date: endedAt.toISOString(),
    behaviors: behaviorResults(tests),
    lostEnters: tests.flatMap((test) =>
      (test.lostEnters ?? []).map((lost) => ({ test: test.name, ...lost })),
    ),
  };
}
