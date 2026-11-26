import { expect, it } from 'vitest';
import type { AgentSession } from '../support/agent-session.ts';
import type { Question, Step } from '../support/fake-agent/script.ts';
import { INTERRUPTED } from '../support/fake-agent/transcript.ts';
import { userTexts } from './harness.ts';
import { hooksOfBothAgents, type ParityAgent, type Scenario } from './parity-agents.ts';

/**
 * The fake agent is held to the real one here: each scenario is played once
 * on each, and what their hooks said must agree. A difference is closed in
 * the fake agent, which plays it or refuses it; never in the comparison.
 */

/** A shell command that needs nothing and prints nothing, with what the real agent says of it once it ran. */
function touch(file: string): Step {
  return {
    do: 'tool',
    name: 'Bash',
    input: { command: `touch ${file}` },
    response: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: true,
    },
    result: '(Bash completed with no output)',
  };
}

const fruit: Question = {
  question: 'Which fruit?',
  header: 'Fruit',
  options: [
    { label: 'Mango', description: 'Sweet.' },
    { label: 'Lime', description: 'Sour.' },
  ],
  multiSelect: false,
};

function reply(text: string): Step {
  return { do: 'reply', text };
}

/** Waits for the end of a turn that replied: the reply shown and the turn's end, each by its hook. */
async function turnEnded(agent: ParityAgent): Promise<void> {
  await agent.hook('MessageDisplay');
  await agent.hook('Stop');
}

async function typed(agent: ParityAgent, session: AgentSession, prompt: string): Promise<void> {
  await session.type(prompt);
  await session.press('Enter');
  await agent.hook('UserPromptSubmit');
}

/** Ends a session by SIGTERM, and waits for the two hooks that tell of it: the post and the command. */
async function terminated(agent: ParityAgent, session: AgentSession): Promise<void> {
  await agent.end(session, 'SIGTERM');
  await agent.hook('SessionEnd');
  await agent.hook('SessionEnd');
}

function permissionDecision(decision: object): object {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/**
 * States that the two agents agree on a scenario. The scenarios are played
 * alongside each other: each has receivers, folders and tmux sockets of its own.
 */
function agreeOn(title: string, scenario: Scenario): void {
  it.concurrent(title, async ({ onTestFinished }) => {
    const { real, fake } = await hooksOfBothAgents(scenario, onTestFinished);
    expect(fake).toEqual(real);
  });
}

agreeOn('a prompt on the command line, answered with one line', {
  script: [[reply('One line.')]],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('a typed prompt, answered after a tool call that needs no permission', {
  script: [[touch('a.txt'), reply('Touched.')]],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await typed(agent, session, 'touch it');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('two tool calls that need permission: one allowed through PermissionRequest, one denied', {
  script: [[touch('a.txt'), touch('b.txt'), reply('One of the two.')]],
  permissions: {},
  async play(agent) {
    agent.hooks.hold('PermissionRequest');
    const session = await agent.startNew({ prompt: 'touch both' });
    (await agent.hook('PermissionRequest')).answer(permissionDecision({ behavior: 'allow' }));
    (await agent.hook('PermissionRequest')).answer(
      permissionDecision({ behavior: 'deny', message: 'Not that one.' }),
    );
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('a question, answered through PreToolUse with the answers in updatedInput', {
  script: [[{ do: 'question', questions: [fruit] }, reply('Lime it is.')]],
  async play(agent) {
    agent.hooks.hold('PreToolUse');
    const session = await agent.startNew({ prompt: 'ask me' });
    (await agent.hook('PreToolUse')).answer({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { questions: [fruit], answers: { [fruit.question]: 'Lime' } },
      },
    });
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('Esc during a turn that has run a tool, then a prompt', {
  script: [[touch('a.txt'), { do: 'stay-busy' }], [reply('Going on.')]],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await typed(agent, session, 'touch, then think');
    await agent.staysBusy(session);
    await session.press('Escape');
    await agent.eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
    // The barrier: a hook of the interrupted turn would come before this prompt's own.
    await typed(agent, session, 'go on');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('the resume of a conversation, then a prompt', {
  script: [[reply('The earlier answer.')], [reply('The later answer.')]],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'the earlier prompt' });
    await agent.hook('SessionStart');
    await turnEnded(agent);
    await terminated(agent, session);
    const resumed = await agent.resume(session.id);
    await agent.hook('SessionStart');
    await typed(agent, resumed, 'the later prompt');
    await turnEnded(agent);
    await terminated(agent, resumed);
  },
});

agreeOn('the end by SIGTERM of a session that took no prompt', {
  script: [],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await terminated(agent, session);
  },
});
