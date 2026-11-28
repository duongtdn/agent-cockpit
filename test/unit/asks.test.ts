import { describe, expect, it } from 'vitest';
import { type AnswerHandOff, Asks, AsksClosedError } from '../../src/server/asks/asks.ts';
import type { AskContent } from '../../src/server/driver.ts';
import type { Ask, AskAnswer, AskSettled } from '../../src/shared/ask.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

const OPENED_AT = '2026-11-28T09:30:00.000Z';

const LIST: AskContent = {
  kind: 'permission',
  tool: 'Bash',
  input: { command: 'ls', description: 'List the folder' },
  description: 'List the folder',
};
const WRITE: AskContent = {
  kind: 'permission',
  tool: 'Write',
  input: { file_path: '/work/a.txt', content: 'a' },
};

/** A registry on a fixed clock, keeping what its handlers threw. */
function registry() {
  const thrown: unknown[] = [];
  const asks = new Asks({
    clock: () => new Date(OPENED_AT),
    handlerThrew: (error) => void thrown.push(error),
  });
  return { asks, thrown };
}

/** A held connection: keeps the answers handed to it, and says whether each was written. */
function connection(outcome: 'written' | 'closed' = 'written') {
  const handed: AskAnswer[] = [];
  const handOff: AnswerHandOff = (answer) => {
    handed.push(answer);
    return outcome;
  };
  return { handed, answering: { answerable: 'app', handOff } as const };
}

const TERMINAL_ONLY = { answerable: 'terminal' } as const;

/** What the promise rejected with, as a `CockpitError`'s code and fields. */
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!isCockpitError(error)) throw new Error(`Expected a CockpitError, got ${String(error)}`);
  return { ...error };
}

/** Collects what a follower or a settled handler is given. */
function collector<T>() {
  const seen: T[] = [];
  return { seen, handler: (value: T) => void seen.push(value) };
}

describe('an ask opened', () => {
  it('gets an id, its key, its content, who can answer it and when it opened', () => {
    const { asks } = registry();
    const ask = asks.open('k1', LIST, connection().answering);
    expect(ask).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      key: 'k1',
      kind: 'permission',
      tool: 'Bash',
      input: { command: 'ls', description: 'List the folder' },
      description: 'List the folder',
      answerable: 'app',
      since: OPENED_AT,
    });
    expect(asks.open('k1', LIST, connection().answering).id).not.toBe(ask.id);
  });

  it('is pending in its key, in the order the asks opened', () => {
    const { asks } = registry();
    const first = asks.open('k1', LIST, connection().answering);
    asks.open('k2', WRITE, connection().answering);
    const third = asks.open('k1', WRITE, TERMINAL_ONLY);
    expect(asks.pending('k1')).toEqual([first, third]);
  });
});

describe('answering an ask', () => {
  it('hands the answer to its connection, settles it app, tells each settled handler, then resolves', async () => {
    const { asks } = registry();
    const held = connection();
    const ask = asks.open('k1', LIST, held.answering);
    const settled = collector<AskSettled>();
    asks.on('settled', settled.handler);

    await expect(
      asks.answer(ask.id, { allow: true, remember: 'session' }),
    ).resolves.toBeUndefined();

    expect(held.handed).toEqual([{ allow: true, remember: 'session' }]);
    expect(settled.seen).toEqual([{ id: ask.id, key: 'k1', by: 'app' }]);
    expect(asks.pending('k1')).toEqual([]);
  });

  it('refuses a second answer already-settled by the app, and hands it to no one', async () => {
    const { asks } = registry();
    const held = connection();
    const ask = asks.open('k1', LIST, held.answering);
    await asks.answer(ask.id, { allow: false });

    expect(await refusal(asks.answer(ask.id, { allow: true }))).toMatchObject({
      code: 'already-settled',
      id: ask.id,
      by: 'app',
    });
    expect(held.handed).toEqual([{ allow: false }]);
  });

  it('settles the ask cancelled when its connection was found closed, and refuses the answer so', async () => {
    const { asks } = registry();
    const ask = asks.open('k1', LIST, connection('closed').answering);
    const settled = collector<AskSettled>();
    asks.on('settled', settled.handler);

    expect(await refusal(asks.answer(ask.id, { allow: true }))).toMatchObject({
      code: 'already-settled',
      id: ask.id,
      by: 'cancelled',
    });
    expect(settled.seen).toEqual([{ id: ask.id, key: 'k1', by: 'cancelled' }]);
    expect(await refusal(asks.answer(ask.id, { allow: true }))).toMatchObject({
      by: 'cancelled',
    });
  });
});

describe('the refusals of an answer, in order', () => {
  it('refuses an id never opened unknown-id', async () => {
    const { asks } = registry();
    expect(await refusal(asks.answer('nobody', { allow: true }))).toMatchObject({
      code: 'unknown-id',
      id: 'nobody',
    });
  });

  it('refuses a settled ask already-settled before it looks at the answer', async () => {
    const { asks } = registry();
    const ask = asks.open('k1', LIST, TERMINAL_ONLY);
    asks.settle(ask.id, 'terminal');
    expect(await refusal(asks.answer(ask.id, 'not an answer'))).toMatchObject({
      code: 'already-settled',
      id: ask.id,
      by: 'terminal',
    });
  });

  it('refuses an ask answerable in the terminal only terminal-only before it looks at the answer', async () => {
    const { asks } = registry();
    const ask = asks.open('k1', LIST, TERMINAL_ONLY);
    expect(await refusal(asks.answer(ask.id, 'not an answer'))).toMatchObject({
      code: 'terminal-only',
      id: ask.id,
    });
    expect(asks.pending('k1')).toEqual([ask]);
  });

  it('refuses an answer that does not fit invalid-answer, with its issues, the ask left pending', async () => {
    const { asks } = registry();
    const held = connection();
    const ask = asks.open('k1', LIST, held.answering);
    expect(await refusal(asks.answer(ask.id, { allow: true, approve: true }))).toMatchObject({
      code: 'invalid-answer',
      id: ask.id,
      issues: [{ path: [], message: expect.stringContaining('approve') }],
    });
    expect(held.handed).toEqual([]);
    expect(asks.pending('k1')).toEqual([ask]);
  });
});

describe('the settled asks remembered', () => {
  it('keeps the 1,000 most recent of a key: an older one is unknown-id', async () => {
    const { asks } = registry();
    const oldest = asks.open('k1', LIST, TERMINAL_ONLY);
    asks.settle(oldest.id, 'cancelled');
    const second = asks.open('k1', LIST, TERMINAL_ONLY);
    asks.settle(second.id, 'cancelled');
    for (let index = 0; index < 999; index += 1) {
      asks.settle(asks.open('k1', LIST, TERMINAL_ONLY).id, 'terminal');
    }
    const otherKey = asks.open('k2', LIST, TERMINAL_ONLY);
    asks.settle(otherKey.id, 'terminal');

    expect(await refusal(asks.answer(oldest.id, { allow: true }))).toMatchObject({
      code: 'unknown-id',
    });
    expect(await refusal(asks.answer(second.id, { allow: true }))).toMatchObject({
      code: 'already-settled',
      by: 'cancelled',
    });
    expect(await refusal(asks.answer(otherKey.id, { allow: true }))).toMatchObject({
      code: 'already-settled',
    });
  });

  it('forgets those of a key removed: a later answer is unknown-id', async () => {
    const { asks } = registry();
    const removed = asks.open('k1', LIST, connection().answering);
    await asks.answer(removed.id, { allow: true });
    const kept = asks.open('k2', LIST, TERMINAL_ONLY);
    asks.settle(kept.id, 'terminal');

    asks.forget('k1');

    expect(await refusal(asks.answer(removed.id, { allow: true }))).toMatchObject({
      code: 'unknown-id',
    });
    expect(await refusal(asks.answer(kept.id, { allow: true }))).toMatchObject({
      code: 'already-settled',
    });
  });
});

describe('the settlements remembered, by scope', () => {
  it("gives those of a key, or of every key with '*', oldest first, until the key is removed", async () => {
    const { asks } = registry();
    const first = asks.open('k1', LIST, connection().answering);
    const second = asks.open('k2', WRITE, TERMINAL_ONLY);
    const third = asks.open('k1', WRITE, TERMINAL_ONLY);
    asks.open('k1', LIST, TERMINAL_ONLY);
    asks.settle(third.id, 'cancelled');
    asks.settle(second.id, 'terminal');
    await asks.answer(first.id, { allow: true });

    expect(asks.settled('k1')).toEqual([
      { id: third.id, key: 'k1', by: 'cancelled' },
      { id: first.id, key: 'k1', by: 'app' },
    ]);
    expect(asks.settled('*')).toEqual([
      { id: third.id, key: 'k1', by: 'cancelled' },
      { id: second.id, key: 'k2', by: 'terminal' },
      { id: first.id, key: 'k1', by: 'app' },
    ]);
    asks.forget('k1');
    expect(asks.settled('*')).toEqual([{ id: second.id, key: 'k2', by: 'terminal' }]);
    expect(asks.settled('k3')).toEqual([]);
  });

  it("gives the pending asks of every key with '*'", () => {
    const { asks } = registry();
    const first = asks.open('k1', LIST, connection().answering);
    const second = asks.open('k2', WRITE, TERMINAL_ONLY);
    expect(asks.pending('*')).toEqual([first, second]);
  });
});

describe('settling an ask from the core', () => {
  it('settles a pending ask once, tells it once, and says whether it settled it', () => {
    const { asks } = registry();
    const ask = asks.open('k1', LIST, connection().answering);
    const settled = collector<AskSettled>();
    asks.on('settled', settled.handler);

    expect(asks.settle(ask.id, 'terminal')).toBe(true);
    expect(asks.settle(ask.id, 'cancelled')).toBe(false);
    expect(asks.settle('nobody', 'cancelled')).toBe(false);
    expect(settled.seen).toEqual([{ id: ask.id, key: 'k1', by: 'terminal' }]);
  });
});

describe('following the asks', () => {
  it("gives the scope's pending asks at once, in the order they opened, then each new one", () => {
    const { asks } = registry();
    const first = asks.open('k1', LIST, connection().answering);
    asks.open('k2', WRITE, connection().answering);
    const settledOne = asks.open('k1', WRITE, TERMINAL_ONLY);
    asks.settle(settledOne.id, 'terminal');
    const third = asks.open('k1', WRITE, TERMINAL_ONLY);
    const followed = collector<Ask>();

    asks.follow('k1', followed.handler);
    expect(followed.seen).toEqual([first, third]);

    asks.open('k2', LIST, connection().answering);
    const fourth = asks.open('k1', LIST, connection().answering);
    expect(followed.seen).toEqual([first, third, fourth]);
  });

  it("follows every key with '*', and a key with no ask yet all the same", () => {
    const { asks } = registry();
    const first = asks.open('k1', LIST, connection().answering);
    const second = asks.open('k2', WRITE, TERMINAL_ONLY);
    const everyKey = collector<Ask>();
    const laterKey = collector<Ask>();

    asks.follow('*', everyKey.handler);
    asks.follow('k3', laterKey.handler);
    const third = asks.open('k3', LIST, TERMINAL_ONLY);

    expect(everyKey.seen).toEqual([first, second, third]);
    expect(laterKey.seen).toEqual([third]);
  });

  it('gives an ask again, under its id, when who can answer it changes; not when it stays the same', async () => {
    const { asks } = registry();
    const ask = asks.open('k1', LIST, TERMINAL_ONLY);
    const followed = collector<Ask>();
    asks.follow('k1', followed.handler);

    const held = connection();
    asks.changeAnswering(ask.id, held.answering);
    asks.changeAnswering(ask.id, connection().answering);

    expect(followed.seen).toEqual([ask, { ...ask, answerable: 'app' }]);
    expect(asks.pending('k1')).toEqual([{ ...ask, answerable: 'app' }]);
    await asks.answer(ask.id, { allow: true });
    expect(held.handed).toEqual([]);
  });

  it('never gives a settled ask, nor one settled while the pending ones are given', () => {
    const { asks } = registry();
    const first = asks.open('k1', LIST, connection().answering);
    const second = asks.open('k1', WRITE, connection().answering);
    const followed = collector<Ask>();

    asks.follow('k1', (ask) => {
      followed.handler(ask);
      asks.settle(second.id, 'cancelled');
    });
    asks.changeAnswering(second.id, TERMINAL_ONLY);

    expect(followed.seen).toEqual([first]);
  });

  it('stops following once told to', () => {
    const { asks } = registry();
    const followed = collector<Ask>();
    const stop = asks.follow('*', followed.handler);
    stop();
    asks.open('k1', LIST, connection().answering);
    expect(followed.seen).toEqual([]);
  });

  it('hands the same answer to the connection with or without a follower', async () => {
    const answered = async (follow: boolean) => {
      const { asks } = registry();
      if (follow) asks.follow('*', () => {});
      const held = connection();
      const ask = asks.open('k1', LIST, held.answering);
      await asks.answer(ask.id, { allow: false, message: 'Not now.' });
      return held.handed;
    };
    expect(await answered(true)).toEqual(await answered(false));
  });

  it('sends what a follower throws to the error sink, the others told and the follower kept', () => {
    const { asks, thrown } = registry();
    const failure = new Error('the page broke');
    const others = collector<Ask>();
    let calls = 0;
    asks.follow('*', () => {
      calls += 1;
      throw failure;
    });
    asks.follow('*', others.handler);

    const first = asks.open('k1', LIST, connection().answering);
    const second = asks.open('k1', WRITE, connection().answering);

    expect(thrown).toEqual([failure, failure]);
    expect(calls).toBe(2);
    expect(others.seen).toEqual([first, second]);
  });
});

describe('the settled event', () => {
  it('tells each settlement once, of every key, until unsubscribed', async () => {
    const { asks } = registry();
    const settled = collector<AskSettled>();
    const unsubscribe = asks.on('settled', settled.handler);
    const byApp = asks.open('k1', LIST, connection().answering);
    const byTerminal = asks.open('k2', WRITE, TERMINAL_ONLY);

    await asks.answer(byApp.id, { allow: true });
    asks.settle(byTerminal.id, 'terminal');
    unsubscribe();
    asks.settle(asks.open('k1', LIST, TERMINAL_ONLY).id, 'cancelled');

    expect(settled.seen).toEqual([
      { id: byApp.id, key: 'k1', by: 'app' },
      { id: byTerminal.id, key: 'k2', by: 'terminal' },
    ]);
  });

  it('sends what a handler throws to the error sink, the answer resolving all the same', async () => {
    const { asks, thrown } = registry();
    const failure = new Error('the page broke');
    asks.on('settled', () => {
      throw failure;
    });
    const ask = asks.open('k1', LIST, connection().answering);
    await expect(asks.answer(ask.id, { allow: true })).resolves.toBeUndefined();
    expect(thrown).toEqual([failure]);
  });

  it('refuses an event the asks do not have', () => {
    const { asks } = registry();
    expect(() => asks.on('opened' as 'settled', () => {})).toThrow(TypeError);
  });
});

describe('the asks once the cockpit closed', () => {
  it('tell nobody: no follower nor settled handler is called, an ask the core settles or opens included', () => {
    const { asks } = registry();
    const pending = asks.open('k1', LIST, connection().answering);
    const followed = collector<Ask>();
    const settled = collector<AskSettled>();
    asks.follow('*', followed.handler);
    asks.on('settled', settled.handler);
    followed.seen.length = 0;

    asks.close();
    asks.settle(pending.id, 'terminal');
    asks.open('k1', WRITE, connection().answering);
    asks.follow('*', followed.handler);
    asks.on('settled', settled.handler);

    expect(followed.seen).toEqual([]);
    expect(settled.seen).toEqual([]);
  });

  it('refuse an answer with an error of no code, handing it to no connection and settling nothing', async () => {
    const { asks } = registry();
    const held = connection();
    const ask = asks.open('k1', LIST, held.answering);
    const settled = collector<AskSettled>();
    asks.on('settled', settled.handler);

    asks.close();
    const refused = asks.answer(ask.id, { allow: true });

    await expect(refused).rejects.toThrow(AsksClosedError);
    await expect(refused).rejects.not.toHaveProperty('code');
    expect(held.handed).toEqual([]);
    expect(settled.seen).toEqual([]);
  });
});
