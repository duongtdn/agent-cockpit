import { describe, expect, it } from 'vitest';
import { messageEvents, turnMessage } from '../support/fake-api/message.ts';
import {
  apiError,
  cutStream,
  heldTurn,
  toolUse,
  turn,
  withUsage,
} from '../support/fake-api/script.ts';

const identity = { model: 'claude-test', sequence: 3 };

describe('a scripted turn as a message', () => {
  it('ends the turn when it only says something', () => {
    const message = turnMessage(turn('Hello'), identity);

    expect(message).toEqual({
      id: 'msg_fake_3',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  it('stops for the tools when it calls one, whatever its name and input', () => {
    const question = { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] };
    const message = turnMessage(
      turn(
        'Let me ask.',
        toolUse('AskUserQuestion', question),
        toolUse('mcp__cockpit__reply', { text: 'hi' }),
        toolUse('Agent', { prompt: 'Look around', subagent_type: 'general-purpose' }),
      ),
      identity,
    );

    expect(message.stop_reason).toBe('tool_use');
    expect(message.content).toEqual([
      { type: 'text', text: 'Let me ask.' },
      { type: 'tool_use', id: 'toolu_fake_3_1', name: 'AskUserQuestion', input: question },
      {
        type: 'tool_use',
        id: 'toolu_fake_3_2',
        name: 'mcp__cockpit__reply',
        input: { text: 'hi' },
      },
      {
        type: 'tool_use',
        id: 'toolu_fake_3_3',
        name: 'Agent',
        input: { prompt: 'Look around', subagent_type: 'general-purpose' },
      },
    ]);
  });

  it('gives each tool call an id no other message repeats', () => {
    const first = turnMessage(turn(toolUse('Bash', { command: 'true' })), identity);
    const second = turnMessage(turn(toolUse('Bash', { command: 'true' })), {
      ...identity,
      sequence: 4,
    });

    expect(first.content[0]).not.toEqual(second.content[0]);
  });

  it('reports the usage a test gives, and the defaults for the rest', () => {
    const scripted = withUsage(turn('Hello'), {
      input_tokens: 150_000,
      cache_read_input_tokens: 9,
    });

    expect(turnMessage(scripted, identity).usage).toEqual({
      input_tokens: 150_000,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 9,
    });
  });
});

describe('a message as stream events', () => {
  it('streams a text block and a tool call in the order of the Messages API', () => {
    const message = turnMessage(turn('Hi', toolUse('Bash', { command: 'true' })), identity);

    expect(messageEvents(message)).toEqual([
      {
        type: 'message_start',
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...message.usage, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_fake_3_1', name: 'Bash', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"true"}' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ]);
  });
});

describe('the other scripted answers', () => {
  it('names the error type of a status the API uses', () => {
    expect(apiError(529)).toMatchObject({ status: 529, errorType: 'overloaded_error' });
    expect(apiError(400)).toMatchObject({ status: 400, errorType: 'invalid_request_error' });
    expect(apiError(401)).toMatchObject({ status: 401, errorType: 'authentication_error' });
    expect(apiError(429)).toMatchObject({ status: 429, errorType: 'rate_limit_error' });
  });

  it('takes the type and the message a test gives', () => {
    expect(apiError(418, { errorType: 'teapot_error', message: 'Short and stout' })).toEqual({
      kind: 'error',
      status: 418,
      errorType: 'teapot_error',
      message: 'Short and stout',
    });
  });

  it('cuts a stream inside the first block unless told where', () => {
    expect(cutStream(turn('Hello')).afterEvents).toBe(3);
    expect(cutStream(turn('Hello'), { afterEvents: 1 }).afterEvents).toBe(1);
  });

  it('holds a short text turn unless given one', () => {
    expect(heldTurn().turn).toEqual(turn('ok'));
    expect(heldTurn(turn('Done')).turn).toEqual(turn('Done'));
  });
});
