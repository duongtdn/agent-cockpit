import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CockpitError,
  type CockpitErrorCode,
  type CockpitErrorFields,
  isCockpitError,
} from '../../src/shared/cockpit-error.ts';
import type { Pending, SessionState } from '../../src/shared/session.ts';

const issues = [{ path: ['chapters', 0, 'title'], message: 'Expected a string.' }];

/** Every code with every field it can carry, the optional ones too. */
const everyField: { [C in CockpitErrorCode]: Required<CockpitErrorFields[C]> } = {
  'invalid-options': { issues },
  'unsupported-machine': { what: 'tmux', found: '3.0', required: '3.2a' },
  'cockpit-locked': { holder: 4242 },
  'unknown-job': { jobId: 'draft-chapter' },
  'invalid-arguments': { issues },
  'not-a-choice': { field: 'book', value: { id: 7 } },
  'folder-outside-app': { folder: '/elsewhere' },
  'folder-changed': { recorded: '/app/a', computed: '/app/b' },
  'unknown-key': { key: 'chapter-9' },
  'wrong-state': { key: 'chapter-1', state: 'waiting', pending: [{ kind: 'ask', id: 'a1' }] },
  'prompt-not-taken': { key: 'chapter-1', state: 'idle' },
  'prompt-too-long': { length: 100_001, max: 100_000 },
  'interrupt-unconfirmed': { key: 'chapter-1', state: 'busy' },
  'agent-not-found': { command: 'claude' },
  'agent-too-old': { found: '1.0.0', oldestTested: '2.0.0' },
  unobservable: { key: 'chapter-1', cause: 'The hooks did not fire.' },
  'session-cap-reached': { cap: 2, live: ['chapter-1', 'chapter-2'] },
  'unknown-id': { id: 'a9' },
  'already-settled': { id: 'a1', by: 'terminal' },
  'terminal-only': { id: 'a1' },
  'invalid-answer': { id: 'a1', issues },
  'not-logged-in': {},
  'model-unavailable': { model: 'no-such-model' },
  'invalid-output': { issues, raw: '{"title": 1}' },
  'api-error': { status: 529, detail: 'Overloaded.' },
  refused: { cause: 'origin' },
  'no-token': {},
  unreachable: {},
};

/** The fields, of any code, named like a property that makes the error's identity. */
type FieldNamedLikeTheIdentity = {
  [C in CockpitErrorCode]: keyof CockpitErrorFields[C] &
    ('name' | 'code' | 'message' | 'stack' | 'toJSON');
}[CockpitErrorCode];

/** Creates an error of a code known only at run time, as a table of codes needs. */
function createError(code: CockpitErrorCode, fields: object): CockpitError {
  return new (CockpitError as new (code: string, message: string, fields: object) => CockpitError)(
    code,
    'What went wrong.',
    fields,
  );
}

describe('CockpitError', () => {
  it('is an Error that carries its code, its message and the fields of its code', () => {
    const error = new CockpitError('folder-changed', 'The folder moved.', {
      recorded: '/app/a',
      computed: '/app/b',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CockpitError);
    expect(error.name).toBe('CockpitError');
    expect(error.code).toBe('folder-changed');
    expect(error.message).toBe('The folder moved.');
    expect(error.recorded).toBe('/app/a');
    expect(error.computed).toBe('/app/b');
  });

  it('needs no fields for a code that has none', () => {
    const error = new CockpitError('no-token', 'Open the link first.');

    expect(error.code).toBe('no-token');
    expect(error.cause).toBeUndefined();
  });

  it('keeps the error that lies under it as its cause', () => {
    const under = new Error('ENOENT');

    const error = new CockpitError('agent-not-found', 'No such command.', {
      command: 'claude',
      cause: under,
    });

    expect(error.cause).toBe(under);
    expect(error.command).toBe('claude');
  });

  it('has the cause of its code where the code names one', () => {
    const error = new CockpitError('refused', 'Not from this machine.', { cause: 'remote' });

    expect(error.cause).toBe('remote');
  });

  it('keeps an optional field out when it is not given', () => {
    const error = new CockpitError('wrong-state', 'The session is busy.', {
      key: 'chapter-1',
      state: 'busy',
    });

    expect('pending' in error).toBe(false);
  });

  it('narrows the fields on a switch over the code', () => {
    const error: CockpitError = new CockpitError('wrong-state', 'Something waits.', {
      key: 'chapter-1',
      state: 'waiting',
      pending: [
        { kind: 'ask', id: 'a1' },
        { kind: 'terminal', dialog: 'trust-folder' },
      ],
    });

    const summary = describeError(error);

    expect(summary).toBe('chapter-1 is waiting on 2');
  });
});

describe('the identity of a CockpitError', () => {
  /** Details as untyped code could give them: a parsed body, a spread of another error. */
  const impostor = {
    key: 'chapter-9',
    name: 'TypeError',
    code: 'no-token',
    message: 'Another message.',
    stack: 'Another stack.',
    toJSON: () => ({ forged: true }),
  };

  it('is never overwritten by the details it is given', () => {
    const error = createError('unknown-key', impostor);

    expect(error.name).toBe('CockpitError');
    expect(error.code).toBe('unknown-key');
    expect(error.message).toBe('What went wrong.');
    expect(error.stack).toContain('What went wrong.');
    expect(error.stack).not.toContain('Another stack.');
    expect(isCockpitError(error, 'unknown-key')).toBe(true);
  });

  it('stays what a spread and JSON show, with the fields of the code', () => {
    const error = createError('unknown-key', impostor);

    expect({ ...error }).toEqual({ name: 'CockpitError', code: 'unknown-key', key: 'chapter-9' });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'CockpitError',
      code: 'unknown-key',
      message: 'What went wrong.',
      key: 'chapter-9',
    });
  });

  it('is refused among the details by the types', () => {
    const fields = { key: 'chapter-9' };

    // @ts-expect-error -- `code` is the error's own
    new CockpitError('unknown-key', 'No such unit of work.', { ...fields, code: 'no-token' });
    // @ts-expect-error -- `name` is the error's own
    new CockpitError('unknown-key', 'No such unit of work.', { ...fields, name: 'TypeError' });
    // @ts-expect-error -- `message` is the error's own
    new CockpitError('unknown-key', 'No such unit of work.', { ...fields, message: 'Other.' });
    // @ts-expect-error -- `stack` is the error's own
    new CockpitError('unknown-key', 'No such unit of work.', { ...fields, stack: 'Other.' });
    // @ts-expect-error -- `toJSON` is the error's own
    new CockpitError('unknown-key', 'No such unit of work.', { ...fields, toJSON: () => ({}) });
    // @ts-expect-error -- another error is no details, whatever fields it carries
    new CockpitError('unknown-key', 'No such unit of work.', impostor);

    expectTypeOf<FieldNamedLikeTheIdentity>().toBeNever();
  });
});

describe('a CockpitError of one code among several', () => {
  const code = 'no-token' as 'no-token' | 'unknown-key';

  it('takes the fields of every code it may have', () => {
    const error = new CockpitError(code, 'Either.', { key: 'chapter-9' });

    expect({ ...error }).toEqual({ name: 'CockpitError', code: 'no-token', key: 'chapter-9' });
    expectTypeOf(error).toEqualTypeOf<CockpitError<'no-token' | 'unknown-key'>>();
  });

  it('requires the fields any of its codes requires', () => {
    // @ts-expect-error -- `key` is required when the code may be `unknown-key`
    new CockpitError(code, 'Either.');
    // @ts-expect-error -- `key` is required when the code may be `unknown-key`
    new CockpitError(code, 'Either.', {});
    // @ts-expect-error -- `jobId` is required when the code may be `unknown-job`
    new CockpitError(code as 'unknown-key' | 'unknown-job', 'Either.', { key: 'chapter-9' });

    const withoutFields = 'no-token' as 'no-token' | 'unreachable';
    expect(new CockpitError(withoutFields, 'Either.').code).toBe('no-token');
  });
});

describe('a CockpitError, serialized', () => {
  it.each(Object.entries(everyField))('keeps every field of %s as JSON', (code, fields) => {
    const error = createError(code as CockpitErrorCode, fields);

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'CockpitError',
      code,
      message: 'What went wrong.',
      ...fields,
    });
  });

  it.each(Object.entries(everyField))(
    'has every field of %s as a property of its own',
    (code, fields) => {
      const error = createError(code as CockpitErrorCode, fields);

      expect({ ...error }).toEqual({ name: 'CockpitError', code, ...fields });
    },
  );

  it.each([
    ['refused', 'origin'],
    ['unobservable', 'The hooks did not fire.'],
  ] as const)('keeps the cause of %s, which is a field of the code', (code, cause) => {
    const error = createError(code, everyField[code]);

    expect(error.cause).toBe(cause);
    expect(error.toJSON()).toMatchObject({ cause });
  });

  it('leaves out the error that lies under it, and its stack', () => {
    const error = new CockpitError('agent-not-found', 'No such command.', {
      command: 'claude',
      cause: new Error('ENOENT'),
    });

    expect(error.toJSON()).toEqual({
      name: 'CockpitError',
      code: 'agent-not-found',
      message: 'No such command.',
      command: 'claude',
    });
  });

  it('leaves out an optional field that was not given', () => {
    const error = new CockpitError('api-error', 'The API failed.', { detail: 'Overloaded.' });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'CockpitError',
      code: 'api-error',
      message: 'The API failed.',
      detail: 'Overloaded.',
    });
  });
});

describe('the types of a CockpitError', () => {
  it('give each field the type its code says', () => {
    expectTypeOf<CockpitError<'wrong-state'>['key']>().toEqualTypeOf<string>();
    expectTypeOf<CockpitError<'wrong-state'>['state']>().toEqualTypeOf<SessionState>();
    expectTypeOf<CockpitError<'wrong-state'>['pending']>().toEqualTypeOf<
      readonly Pending[] | undefined
    >();
    expectTypeOf<CockpitError<'api-error'>['status']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<CockpitError<'unobservable'>['cause']>().toEqualTypeOf<string>();
    expectTypeOf<CockpitError<'refused'>['cause']>().toEqualTypeOf<
      'remote' | 'forwarded' | 'origin' | 'host' | 'local-address' | 'terminal-off'
    >();
    expectTypeOf<CockpitError<'unknown-key'>['cause']>().toEqualTypeOf<unknown>();
  });

  it('require the fields a code requires', () => {
    // @ts-expect-error -- `key` is required
    new CockpitError('unknown-key', 'No such unit of work.');
    // @ts-expect-error -- `key` is required
    new CockpitError('unknown-key', 'No such unit of work.', {});
    // @ts-expect-error -- `state` is required
    new CockpitError('wrong-state', 'The session is busy.', { key: 'chapter-1' });
    // @ts-expect-error -- `detail` is required, though `status` is not
    new CockpitError('api-error', 'The API failed.', { status: 529 });
    // @ts-expect-error -- `cause` is a required field of `refused`
    new CockpitError('refused', 'Not from this machine.');
    // @ts-expect-error -- `cause` is a required field of `unobservable`
    new CockpitError('unobservable', 'No signal.', { key: 'chapter-1' });

    expect(new CockpitError('api-error', 'The API failed.', { detail: 'Overloaded.' }).status).toBe(
      undefined,
    );
  });

  it('refuse a field the code does not have, and a value of another type', () => {
    // @ts-expect-error -- `no-token` carries no field
    new CockpitError('no-token', 'Open the link first.', { bogus: true });
    // @ts-expect-error -- `unknown-key` has no field `bogus`
    new CockpitError('unknown-key', 'No such unit of work.', { key: 'chapter-9', bogus: true });
    // @ts-expect-error -- `holder` is a number
    new CockpitError('cockpit-locked', 'Already running.', { holder: '4242' });
    // @ts-expect-error -- the cause of `refused` is one of its checks, not an error
    new CockpitError('refused', 'Not from this machine.', { cause: new Error('remote') });
    // @ts-expect-error -- there is no such code
    new CockpitError('no-such-code', 'Nothing.');

    expect(
      new CockpitError('no-token', 'Open the link first.', { cause: new Error('x') }).code,
    ).toBe('no-token');
  });
});

function describeError(error: CockpitError): string {
  switch (error.code) {
    case 'wrong-state':
      return `${error.key} is ${error.state} on ${error.pending?.length ?? 0}`;
    case 'prompt-too-long':
      return `${error.length} over ${error.max}`;
    default:
      return error.message;
  }
}

describe('isCockpitError', () => {
  const error = new CockpitError('unknown-key', 'No such unit of work.', { key: 'chapter-9' });

  it('accepts a CockpitError of any code', () => {
    expect(isCockpitError(error)).toBe(true);
  });

  it('accepts a CockpitError of the code asked for, and gives its fields', () => {
    const value: unknown = error;

    expect(isCockpitError(value, 'unknown-key') && value.key).toBe('chapter-9');
  });

  it('rejects a CockpitError of another code', () => {
    expect(isCockpitError(error, 'unknown-job')).toBe(false);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['an object shaped like one', { code: 'unknown-key', key: 'chapter-9', message: 'x' }],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(isCockpitError(value)).toBe(false);
    expect(isCockpitError(value, 'unknown-key')).toBe(false);
  });
});
