/**
 * The agent's version as the cockpit knows it: the last one read, how it
 * stands against the driver's tested range, the notice an app gets once
 * per version that is newer than any tested, and the refusal of a launch
 * whose agent is missing or older than tested (ADR-0054).
 *
 * @packageDocumentation
 */

import { CockpitError } from '../shared/cockpit-error.js';

/** The oldest and the newest versions of the agent a driver's contract tests ran on. */
export interface TestedRange {
  /** The oldest version tested: an older one is refused at launch (`agent-too-old`). */
  readonly oldest: string;
  /** The newest version tested: a newer one runs, with a notice. */
  readonly newest: string;
}

/** What `cockpit.status()` gives: the agent's version, and whether it was tested. */
export interface CockpitStatus {
  /** The agent's version, as last read; absent when none was read, or no agent was found. */
  readonly agentVersion?: string;
  /** Whether that version lies within the tested range; `false` when there is none. */
  readonly tested: boolean;
  /** The driver's tested range. */
  readonly testedRange: TestedRange;
}

/** What `cockpit.on('untested-version', …)` gives: a version newer than any tested. */
export interface UntestedVersion {
  /** The agent's version, newer than the range's newest. */
  readonly agentVersion: string;
  /** The driver's tested range. */
  readonly testedRange: TestedRange;
}

/** A reading of the agent's version, as a driver gives it. */
export type AgentVersion =
  | {
      /** No agent: its command cannot be run. */
      readonly found: false;
      /** The command the driver looked for, as `agent-not-found` names it. */
      readonly command: string;
    }
  | {
      /** The agent answered with its version. */
      readonly found: true;
      /** Its version, as the agent gave it. */
      readonly version: string;
      /** How it stands against the driver's tested range. */
      readonly standing: 'tested' | 'newer' | 'older';
    };

/** The cockpit's knowledge of the agent's version. */
export interface AgentStatus {
  /** @returns The status now. */
  current(): CockpitStatus;
  /**
   * Records a reading taken with no launch, as the cockpit is created: the
   * status follows it, and nothing is told, since no app could listen yet.
   *
   * @param reading - What the driver read.
   */
  record(reading: AgentVersion): void;
  /**
   * Admits the agent a launch would run: records the reading, tells the
   * handlers of a version newer than the range the first time a launch runs
   * it, and refuses an agent that is missing or older than the range.
   *
   * @param reading - What the driver read for the launch.
   * @throws `CockpitError` `agent-not-found` (`command`) when no agent was
   * found; `agent-too-old` (`found`, `oldestTested`) when it is older than
   * the range.
   */
  admit(reading: AgentVersion): void;
  /**
   * Adds a handler of untested versions.
   *
   * @returns A function that removes it.
   */
  onUntested(handler: (event: UntestedVersion) => void): () => void;
}

/**
 * Creates the cockpit's status of the agent, with no version read yet.
 *
 * @param testedRange - The driver's tested range.
 * @param fallback - Receives what a handler throws, so that one handler
 * never keeps the others, or the launch that read the version, from going
 * on (the console, by default).
 * @returns The status.
 */
export function createAgentStatus(
  testedRange: TestedRange,
  fallback: (thrown: unknown) => void = (thrown) => console.error(thrown),
): AgentStatus {
  let status: CockpitStatus = { tested: false, testedRange };
  const told = new Set<string>();
  const handlers = new Set<(event: UntestedVersion) => void>();

  function tell(agentVersion: string): void {
    if (told.has(agentVersion)) return;
    told.add(agentVersion);
    for (const handler of handlers) {
      try {
        handler({ agentVersion, testedRange });
      } catch (thrown) {
        fallback(thrown);
      }
    }
  }

  function record(reading: AgentVersion): void {
    status = reading.found
      ? { agentVersion: reading.version, tested: reading.standing === 'tested', testedRange }
      : { tested: false, testedRange };
  }

  return {
    current: () => status,
    record,
    admit(reading) {
      record(reading);
      if (!reading.found) {
        throw new CockpitError(
          'agent-not-found',
          `The agent's command ${reading.command} is not found on the PATH it is launched with.`,
          { command: reading.command },
        );
      }
      if (reading.standing === 'older') {
        throw new CockpitError(
          'agent-too-old',
          `The agent's version ${reading.version} is older than the oldest the driver was tested on, ${testedRange.oldest}: update the agent.`,
          { found: reading.version, oldestTested: testedRange.oldest },
        );
      }
      if (reading.standing === 'newer') tell(reading.version);
    },
    onUntested(handler) {
      // A handler given twice is two subscriptions, each removed by its own function.
      const subscription = (event: UntestedVersion): void => handler(event);
      handlers.add(subscription);
      return () => {
        handlers.delete(subscription);
      };
    },
  };
}
