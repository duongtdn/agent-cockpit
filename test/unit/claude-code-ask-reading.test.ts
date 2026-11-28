import { beforeEach, describe, expect, it } from 'vitest';
import { createHookReader } from '../../src/claude-code/hook-payloads.ts';
import { type AskOfCall, type DriverEvent, HOOKS_PATH } from '../../src/server/driver.ts';
import { recordedPayload } from '../support/recorded-hooks.ts';

// Every payload is the pinned Claude Code's, as the contract suite recorded it. A test changes a
// field only to make the hooks of one call agree, as the agent's do (the contract suite's rows
// 137, 142, 144, 146 and 147 show which fields a call's hooks share), or to try a value of its own.

type Payload = Record<string, unknown>;

const KEY = 'chapter-1';

let readHook: ReturnType<typeof createHookReader>;
beforeEach(() => {
  readHook = createHookReader();
});

function read(body: Payload, key = KEY) {
  return readHook({ key, path: HOOKS_PATH, body });
}

/** The events of a hook, leaving out `working`, which every call's hook told before asks. */
function askEvents(body: Payload, key = KEY): DriverEvent[] {
  return read(body, key).events.filter((event) => event.type !== 'working');
}

/** The ask a hook opens, failing the test when it opens none. */
function askOf(body: Payload, key = KEY): AskOfCall {
  const { ask } = read(body, key);
  if (ask === undefined) throw new Error(`${String(body.hook_event_name)} opened no ask`);
  return ask;
}

const ofTheSession = (each: Readonly<Payload>) => !('agent_id' in each);

const bashAsked = () =>
  recordedPayload('PermissionRequest', (each) => each.tool_name === 'Bash' && ofTheSession(each));
const writeAsked = () => recordedPayload('PermissionRequest', { tool_name: 'Write' });
const readAsked = () => recordedPayload('PermissionRequest', { tool_name: 'Read' });
const tasksAsk = () => recordedPayload('PermissionRequest', (each) => 'agent_id' in each);

/** A permission of a `Read` of another file, of the same turn. */
function readOf(file: string): Payload {
  const asked = readAsked();
  return { ...asked, tool_input: { file_path: `/run/outside/${file}` } };
}

/** The `PreToolUse` of the call a permission is about: its tool, input and turn. */
function started(asked: Payload, callId: string): Payload {
  const { tool_name, tool_input, prompt_id } = asked;
  const pre = recordedPayload('PreToolUse', { tool_name: 'Read' });
  return { ...pre, tool_name, tool_input, prompt_id, tool_use_id: callId };
}

/**
 * A call's hook in `auto`, where the agent asks some permissions in its terminal alone (row 147);
 * the recorded calls are of `default`, where every permission comes through `PermissionRequest`.
 */
function inAuto(call: Payload): Payload {
  return { ...call, permission_mode: 'auto' };
}

/** The hook that tells a call ran (`PostToolUse`) or failed (`PostToolUseFailure`). */
function finished(call: Payload, event: 'PostToolUse' | 'PostToolUseFailure' = 'PostToolUse') {
  const { tool_name, tool_input, prompt_id, tool_use_id } = call;
  const post = recordedPayload(event, (each) => ofTheSession(each) && each.tool_name !== 'Agent');
  return { ...post, tool_name, tool_input, prompt_id, tool_use_id };
}

const notification = (type: string) => recordedPayload('Notification', { notification_type: type });
const batchEnded = () => recordedPayload('PostToolBatch', (each) => ofTheSession(each));

describe('which PermissionRequests open an ask', () => {
  it("one of the session's own opens a permission ask: its tool, its input and its description", () => {
    const asked = bashAsked();
    read(started(asked, 'toolu_1'));

    const outcome = read(asked);

    expect(outcome.events).toEqual([]);
    expect(outcome.ask).toEqual({
      ref: expect.any(String),
      content: {
        kind: 'permission',
        tool: 'Bash',
        input: { command: 'touch asked.txt', description: 'Create asked.txt' },
        description: 'Create asked.txt',
      },
    });
  });

  it('a call whose input carries no description opens an ask with none', () => {
    const asked = writeAsked();
    read(started(asked, 'toolu_1'));

    expect(askOf(asked).content).toEqual({
      kind: 'permission',
      tool: 'Write',
      input: asked.tool_input,
    });
  });

  it('one that came with no PreToolUse the driver read opens an ask still', () => {
    expect(read(bashAsked()).ask).toMatchObject({ content: { tool: 'Bash' } });
  });

  it("a background task's opens nothing: it carries its agent_id", () => {
    const asked = tasksAsk();
    read(started(asked, 'toolu_1'));

    expect(read(asked)).toEqual({ events: [] });
  });

  it.each(['AskUserQuestion', 'ExitPlanMode'])(
    'one of %s opens nothing: the terminal shows it, as before',
    (tool) => {
      const asked = { ...bashAsked(), tool_name: tool };
      read(started(asked, 'toolu_1'));

      expect(read(asked)).toEqual({ events: [] });
    },
  );

  it('each ask has a reference of its own', () => {
    const refs = ['r1.txt', 'r2.txt', 'r3.txt'].map((file) => askOf(readOf(file)).ref);

    expect(new Set(refs).size).toBe(3);
  });
});

describe('an ask settled by its call', () => {
  it('PostToolUse of the call an ask is about: the call finished, by its reference', () => {
    const asked = bashAsked();
    const call = started(asked, 'toolu_1');
    read(call);
    const { ref } = askOf(asked);

    expect(read(finished(call)).events).toEqual([
      { type: 'working' },
      { type: 'call-finished', ref },
    ]);
  });

  it('PostToolUseFailure of the call an ask is about: the call finished, by its reference', () => {
    const asked = bashAsked();
    const call = started(asked, 'toolu_1');
    read(call);
    const { ref } = askOf(asked);

    expect(read(finished(call, 'PostToolUseFailure')).events).toEqual([
      { type: 'call-finished', ref },
    ]);
  });

  it('three concurrent Reads, asked out of their order: each one finished settles its own ask', () => {
    const asks = ['r1.txt', 'r2.txt', 'r3.txt'].map(readOf);
    const calls = asks.map((asked, index) => started(asked, `toolu_${index}`));
    for (const call of calls) read(call);
    const [ref1, ref2, ref3] = [asks[1], asks[2], asks[0]].map(
      (asked) => askOf(asked as Payload).ref,
    );

    expect(askEvents(finished(calls[0] as Payload))).toEqual([
      { type: 'call-finished', ref: ref3 },
    ]);
    expect(askEvents(finished(calls[2] as Payload))).toEqual([
      { type: 'call-finished', ref: ref2 },
    ]);
    expect(askEvents(finished(calls[1] as Payload))).toEqual([
      { type: 'call-finished', ref: ref1 },
    ]);
  });

  it('identical calls are twins: each one finished settles the oldest ask still open', () => {
    const asked = readAsked();
    const calls = ['toolu_1', 'toolu_2', 'toolu_3'].map((id) => started(asked, id));
    for (const call of calls) read(call);
    const refs = calls.map(() => askOf(asked).ref);

    expect(calls.reverse().flatMap((call) => askEvents(finished(call)))).toEqual(
      refs.map((ref) => ({ type: 'call-finished', ref })),
    );
  });

  it('a call finished whose PreToolUse the driver never read settles the oldest open ask of its tool and input', () => {
    const asked = bashAsked();
    const { ref } = askOf(asked);

    expect(askEvents(finished(started(asked, 'toolu_1')))).toEqual([
      { type: 'call-finished', ref },
    ]);
  });

  it('a call finished of another input, another tool, or with no ask settles nothing', () => {
    const asked = readOf('r1.txt');
    read(started(asked, 'toolu_1'));
    read(asked);

    expect(askEvents(finished(started(readOf('r2.txt'), 'toolu_2')))).toEqual([]);
    expect(askEvents(finished(started({ ...asked, tool_name: 'Edit' }, 'toolu_3')))).toEqual([]);
  });

  it("a background task's call finished settles no ask of the session's, whatever its input", () => {
    const asked = bashAsked();
    read(started(asked, 'toolu_1'));
    askOf(asked);
    const tasksCall = { ...finished(started(asked, 'toolu_2')), agent_id: tasksAsk().agent_id };

    expect(read(tasksCall).events).toEqual([]);
  });

  it("an ask is matched to its call's PreToolUse of the same turn only (prompt_id)", () => {
    const asked = bashAsked();
    read(inAuto(started({ ...asked, prompt_id: 'another-prompt' }, 'toolu_1')));
    askOf(asked);

    // The call has no ask: the agent asking in its terminal is about it.
    expect(askEvents(notification('permission_prompt'))).toEqual([
      { type: 'asked-in-terminal', ask: expect.anything() },
    ]);
  });

  it("asks and calls are each session's own", () => {
    const asked = bashAsked();
    const call = started(asked, 'toolu_1');
    read(call);
    askOf(asked);

    expect(askEvents(finished(call), 'chapter-2')).toEqual([]);
  });
});

describe('the end of a batch', () => {
  it("PostToolBatch of the session's own: the batch ended", () => {
    expect(read(batchEnded()).events).toEqual([{ type: 'batch-ended' }]);
  });

  it("PostToolBatch of a background task's tells nothing", () => {
    expect(read(recordedPayload('PostToolBatch', (each) => 'agent_id' in each)).events).toEqual([]);
  });

  it("a batch's asks end with it: a twin of the next batch settles its own ask", () => {
    const asked = bashAsked();
    read(started(asked, 'toolu_1'));
    askOf(asked);
    read(batchEnded());
    const next = started(asked, 'toolu_2');
    read(next);
    const { ref } = askOf(asked);

    expect(askEvents(finished(next))).toEqual([{ type: 'call-finished', ref }]);
  });
});

describe('a permission asked in the terminal only', () => {
  it.each(['permission_prompt', 'agent_needs_input'])(
    'Notification %s while a call has no ask: an ask of that call, from its PreToolUse',
    (type) => {
      const call = inAuto(started(bashAsked(), 'toolu_1'));
      read(call);

      expect(read(notification(type)).events).toEqual([
        {
          type: 'asked-in-terminal',
          ask: {
            ref: expect.any(String),
            content: {
              kind: 'permission',
              tool: 'Bash',
              input: call.tool_input,
              description: 'Create asked.txt',
            },
          },
        },
      ]);
    },
  );

  it('the panel then the dialog: one ask, opened by the first Notification', () => {
    read(inAuto(started(bashAsked(), 'toolu_1')));
    read(notification('agent_needs_input'));

    expect(read(notification('permission_prompt')).events).toEqual([]);
  });

  it('the oldest call with no ask is the one asked about', () => {
    const held = readOf('r1.txt');
    read(inAuto(started(held, 'toolu_1')));
    read(inAuto(started(readOf('r2.txt'), 'toolu_2')));
    read(inAuto(started(readOf('r3.txt'), 'toolu_3')));
    askOf(held);

    expect(read(notification('permission_prompt')).events).toEqual([
      {
        type: 'asked-in-terminal',
        ask: expect.objectContaining({
          content: expect.objectContaining({ input: readOf('r2.txt').tool_input }),
        }),
      },
    ]);
  });

  it('settled by its call finished, by its reference', () => {
    const call = inAuto(started(bashAsked(), 'toolu_1'));
    read(call);
    const [asked] = read(notification('permission_prompt')).events;
    const ref = asked?.type === 'asked-in-terminal' ? asked.ask.ref : 'none';

    expect(askEvents(finished(call))).toEqual([{ type: 'call-finished', ref }]);
  });

  it('a Notification that follows a held PermissionRequest opens nothing', () => {
    const asked = bashAsked();
    read(inAuto(started(asked, 'toolu_1')));
    askOf(asked);

    expect(read(notification('permission_prompt')).events).toEqual([]);
  });

  it("a call of default mode is never asked about in the terminal alone: a held ask's Notification while a call allowed by a rule still runs opens nothing", () => {
    const asked = bashAsked();
    read(started(readOf('r1.txt'), 'toolu_1'));
    read(started(asked, 'toolu_2'));
    askOf(asked);

    expect(read(notification('permission_prompt')).events).toEqual([]);
  });

  it("in auto, a held ask's Notification while a call allowed by a rule still runs opens an ask of that call: nothing tells it from one asked in the terminal", () => {
    const asked = bashAsked();
    read(inAuto(started(readOf('r1.txt'), 'toolu_1')));
    read(inAuto(started(asked, 'toolu_2')));
    askOf(asked);

    expect(read(notification('permission_prompt')).events).toEqual([
      { type: 'asked-in-terminal', ask: expect.objectContaining({ ref: expect.any(String) }) },
    ]);
  });

  it("a Notification that follows a question's PermissionRequest opens nothing: the terminal's alone", () => {
    const asked = { ...bashAsked(), tool_name: 'AskUserQuestion' };
    read(started(asked, 'toolu_1'));
    read(asked);

    expect(read(notification('permission_prompt')).events).toEqual([]);
  });

  it('a Notification with no call unfinished opens nothing', () => {
    const call = inAuto(started(bashAsked(), 'toolu_1'));
    expect(read(notification('permission_prompt')).events).toEqual([]);

    read(call);
    read(finished(call));
    expect(read(notification('permission_prompt')).events).toEqual([]);
  });

  it("a background task's Notification, or one of another type, opens nothing", () => {
    read(inAuto(started(bashAsked(), 'toolu_1')));
    const tasks = { ...notification('permission_prompt'), agent_id: tasksAsk().agent_id };
    const idle = { ...notification('permission_prompt'), notification_type: 'idle_prompt' };

    expect(read(tasks).events).toEqual([]);
    expect(read(idle).events).toEqual([]);
  });
});

describe('a turn, or a process, drops its calls and asks', () => {
  it.each([
    ['the next prompt (a plain "No" or Esc ends the turn with no PostToolUse)', 'UserPromptSubmit'],
    ['the session starting', 'SessionStart'],
    ['the session ending', 'SessionEnd'],
    ['the turn ending', 'Stop'],
    ['the turn failing', 'StopFailure'],
  ])('at %s', (_, event) => {
    const asked = bashAsked();
    const call = started(asked, 'toolu_1');
    read(call);
    askOf(asked);
    read(inAuto(started(readOf('r1.txt'), 'toolu_2')));

    read(recordedPayload(event, ofTheSession));

    expect(askEvents(finished(call))).toEqual([]);
    expect(read(notification('permission_prompt')).events).toEqual([]);
  });

  it.each(['Stop', 'StopFailure'])(
    'at %s, with no UserPromptSubmit after it: an identical call of the next turn settles its own ask',
    (event) => {
      const asked = bashAsked();
      read(started(asked, 'toolu_1'));
      askOf(asked);
      read(recordedPayload(event, ofTheSession));
      const next = started({ ...asked, prompt_id: 'next-turn' }, 'toolu_2');
      read(next);
      const { ref } = askOf({ ...asked, prompt_id: 'next-turn' });

      expect(askEvents(finished(next))).toEqual([{ type: 'call-finished', ref }]);
    },
  );
});
