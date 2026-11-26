import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { readScreen } from '../../src/claude-code/screen-reading.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import type { Question, ReplyStep, ToolStep } from '../support/fake-agent/script.ts';
import { INTERRUPTED } from '../support/fake-agent/transcript.ts';
import { pinnedAgentBinary } from '../support/real-agent/binary.ts';
import { answerYes, pressOnDialog } from './dialog-keys.ts';
import { submitInputBox, submitPrompt, userTexts } from './harness.ts';
import { hooksOfBothAgents, type ParityAgent, type Scenario } from './parity-agents.ts';

/**
 * The fake agent is held to the real one here: each scenario is played once
 * on each, and what their hooks said must agree. A difference is closed in
 * the fake agent, which plays it or refuses it; never in the comparison.
 */

/** A shell command that needs nothing and prints nothing, with what the real agent says of it once it ran. */
function touch(file: string): ToolStep {
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

function reply(text: string): ReplyStep {
  return { do: 'reply', text };
}

/** Waits for the end of a turn that replied: the reply shown and the turn's end, each by its hook. */
async function turnEnded(agent: ParityAgent): Promise<void> {
  await agent.hook('MessageDisplay');
  await agent.hook('Stop');
}

/** Ends a session by SIGTERM, and waits for the two hooks that tell of it: the post and the command. */
async function terminated(agent: ParityAgent, session: AgentSession): Promise<void> {
  await agent.end(session, 'SIGTERM');
  await agent.hook('SessionEnd');
  await agent.hook('SessionEnd');
}

/**
 * Waits until a session shows a start-up dialog, by a text of it, and
 * observes what the driver reads of the screen then: the two agents' must
 * be read alike.
 */
async function shows(agent: ParityAgent, session: AgentSession, text: string): Promise<void> {
  const screen = await agent.eventually(async () => {
    const shown = await session.screen();
    expect(shown).toContain(text);
    return shown;
  });
  agent.observe(
    `the screen that shows ${JSON.stringify(text)}, as the driver reads it`,
    readScreen(screen),
  );
}

const TRUST_DIALOG = 'Accessing workspace:';
const BYPASS_WARNING = 'WARNING: Claude Code running in Bypass Permissions mode';
const KEY_QUESTION = 'Do you want to use this API key?';

/** Leaves at a start-up dialog with a key, and waits until the session is gone. */
async function leaveAt(agent: ParityAgent, session: AgentSession, key: string): Promise<void> {
  const left = agent.exits(session);
  await pressOnDialog(session, key, (screen) => screen === undefined);
  await left;
}

/** Runs `/compact` as a person types it, and waits for the hook that tells it was taken. */
async function compactCommand(agent: ParityAgent, session: AgentSession): Promise<void> {
  await session.type('/compact');
  await submitInputBox(agent, session, (box) => box.trim() === '/compact', 'PreCompact');
}

function permissionDecision(decision: object): object {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/**
 * States that the two agents agree on a scenario. The scenarios are played
 * alongside each other: each has receivers, folders and tmux sockets of its own.
 */
function agreeOn(title: string, scenario: Scenario): void {
  it.concurrent(title, async ({ onTestFinished, task }) => {
    const { real, fake } = await hooksOfBothAgents(scenario, onTestFinished, task.meta);
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

agreeOn('a prompt on the command line that looks like options, after --', {
  script: [[reply('Read as a prompt.')]],
  async play(agent) {
    const session = await agent.startNew({
      prompt: '-p --permission-mode bypassPermissions --model opus',
    });
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('a typed prompt, answered after a tool call that needs no permission', {
  script: [[touch('a.txt'), reply('Touched.')]],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await submitPrompt(agent, session, 'touch it');
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
    await submitPrompt(agent, session, 'touch, then think');
    await agent.staysBusy(session);
    await session.press('Escape');
    await agent.eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
    // The barrier: a hook of the interrupted turn would come before this prompt's own.
    await submitPrompt(agent, session, 'go on');
    await turnEnded(agent);
    // The marker, among the transcript's other texts of the person's side.
    await agent.eventually(() => expect(userTexts(session)).toContain('go on'));
    agent.observe('the texts of the transcript', userTexts(session));
    await terminated(agent, session);
  },
});

agreeOn('the resume of a conversation, then a prompt', {
  script: [[reply('The earlier answer.')], [reply('The later answer.')]],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'the earlier prompt' });
    await agent.hook('SessionStart');
    await agent.hook('UserPromptSubmit');
    await turnEnded(agent);
    await terminated(agent, session);
    const resumed = await agent.resume(session.id);
    await agent.hook('SessionStart');
    await submitPrompt(agent, resumed, 'the later prompt');
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

agreeOn('the trust dialog answered Yes, then the launch prompt; the next start asks nothing', {
  script: [[reply('Trusted.')]],
  leftOutOfRecipe: ['folder-trust'],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await shows(agent, session, TRUST_DIALOG);
    await answerYes(session, TRUST_DIALOG, 'Down');
    await agent.hook('SessionStart');
    await turnEnded(agent);
    await terminated(agent, session);
    const again = await agent.startNew();
    await agent.hook('SessionStart');
    await terminated(agent, again);
  },
});

agreeOn('the trust dialog left by Enter on its "No, exit", then by Esc: no hook', {
  script: [],
  leftOutOfRecipe: ['folder-trust'],
  async play(agent) {
    for (const key of ['Enter', 'Escape']) {
      const session = await agent.startNew({ prompt: 'say one line' });
      await shows(agent, session, TRUST_DIALOG);
      await leaveAt(agent, session, key);
    }
  },
});

agreeOn('the warning of bypassPermissions left by Enter, then by Esc: SessionEnd each time', {
  script: [],
  async play(agent) {
    for (const key of ['Enter', 'Escape']) {
      const session = await agent.startNew({
        prompt: 'say one line',
        permissionMode: 'bypassPermissions',
      });
      await shows(agent, session, BYPASS_WARNING);
      await leaveAt(agent, session, key);
      await agent.hook('SessionEnd');
      await agent.hook('SessionEnd');
    }
  },
});

agreeOn(
  'the warning of bypassPermissions accepted, then the launch prompt; the next start warns no more',
  {
    script: [[reply('Accepted.')]],
    async play(agent) {
      const permissionMode = 'bypassPermissions';
      const session = await agent.startNew({ prompt: 'say one line', permissionMode });
      await shows(agent, session, BYPASS_WARNING);
      await answerYes(session, BYPASS_WARNING, 'Down');
      await agent.hook('SessionStart');
      await turnEnded(agent);
      await terminated(agent, session);
      const again = await agent.startNew({ permissionMode });
      await agent.hook('SessionStart');
      await terminated(agent, again);
    },
  },
);

agreeOn('the trust dialog answered Yes, then the warning of bypassPermissions left', {
  script: [],
  leftOutOfRecipe: ['folder-trust'],
  async play(agent) {
    const session = await agent.startNew({
      prompt: 'say one line',
      permissionMode: 'bypassPermissions',
    });
    await shows(agent, session, TRUST_DIALOG);
    await answerYes(session, TRUST_DIALOG, 'Down');
    await shows(agent, session, BYPASS_WARNING);
    await leaveAt(agent, session, 'Enter');
    await agent.hook('SessionEnd');
    await agent.hook('SessionEnd');
  },
});

agreeOn('the question about the API key answered No, then a prompt fails on the login', {
  script: [],
  leftOutOfRecipe: ['key-approval'],
  async play(agent) {
    const session = await agent.startNew();
    await shows(agent, session, KEY_QUESTION);
    await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(KEY_QUESTION));
    await agent.hook('SessionStart');
    await submitPrompt(agent, session, 'say one line');
    await agent.hook('StopFailure');
    await terminated(agent, session);
  },
});

agreeOn('the question about the API key answered Yes, then the launch prompt', {
  script: [[reply('With the key.')]],
  leftOutOfRecipe: ['key-approval'],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await shows(agent, session, KEY_QUESTION);
    await answerYes(session, KEY_QUESTION, 'Up');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('turns that fail on errors of the API, one of each kind, then a turn that answers', {
  script: [
    [{ do: 'fail', status: 529 }],
    [{ do: 'fail', status: 500 }],
    [{ do: 'fail', status: 429 }],
    [{ do: 'fail', status: 401 }],
    [touch('a.txt'), { do: 'fail', status: 403 }],
    [reply('Answered.')],
  ],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'the first' });
    await agent.hook('UserPromptSubmit');
    await agent.hook('StopFailure');
    for (const prompt of ['the second', 'the third', 'the fourth', 'the fifth']) {
      await submitPrompt(agent, session, prompt);
      await agent.hook('StopFailure');
    }
    await submitPrompt(agent, session, 'the last');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('/compact after a turn', {
  script: [[reply('Something to compact.')], [{ do: 'compact', summary: 'The summary.' }]],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await turnEnded(agent);
    await compactCommand(agent, session);
    await agent.hook('PostCompact');
    await terminated(agent, session);
  },
});

agreeOn('a task in the background: Stop lists it, its calls name it, its end starts a turn', {
  script: [
    [
      {
        do: 'task',
        description: 'Count files',
        prompt: 'Count the files.',
        agentType: 'general-purpose',
        work: [touch('inner.txt'), reply('Counted.')],
      },
      reply('Started.'),
    ],
    [reply('Noted.')],
  ],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'start a task' });
    await turnEnded(agent);
    await agent.releaseTask();
    await agent.hook('SubagentStop');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

it('--version: the same line, and nothing else', async () => {
  const run = promisify(execFile);
  // Nothing of the person's: not their configuration folder, not their keys.
  const environment = { env: { PATH: '/usr/bin:/bin' } };
  const fake = fakeAgentCommand();
  const [real, ofFake] = await Promise.all([
    run(pinnedAgentBinary(), ['--version'], environment),
    run(fake.command, [...fake.args, '--version'], environment),
  ]);

  expect(ofFake).toEqual(real);
});
