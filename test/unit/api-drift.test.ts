import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CockpitErrorCode, CockpitErrorFields } from '../../src/shared/cockpit-error.ts';
import { readApiDocument } from '../support/api-document.ts';
import { readEntryExports } from '../support/entry-exports.ts';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const document = readApiDocument(fileURLToPath(new URL('docs/api.md', root)));

const entries: [entry: string, index: URL][] = Object.entries<{ import: string }>(
  manifest.exports,
).map(([entry, target]) => [
  entry,
  new URL(target.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts'), root),
]);

/** Whether each field of a code's fields must be given (`required`) or may be left out. */
type Presence<Fields> = {
  [K in keyof Fields]-?: Record<never, never> extends Pick<Fields, K> ? 'optional' : 'required';
};

/**
 * The fields of every code, each required or optional. The type makes the
 * compiler refuse a missing code, a missing field, a field the code does not
 * have and a wrong presence, so this table cannot differ from the code; the
 * test compares the document with it.
 */
const fieldsByCode: {
  [C in CockpitErrorCode]: keyof CockpitErrorFields[C] extends never
    ? Record<string, never>
    : Presence<CockpitErrorFields[C]>;
} = {
  'invalid-options': { issues: 'required' },
  'unsupported-machine': { what: 'required', found: 'required', required: 'required' },
  'cockpit-locked': { holder: 'required' },
  'unknown-job': { jobId: 'required' },
  'invalid-arguments': { issues: 'required' },
  'not-a-choice': { field: 'required', value: 'required' },
  'folder-outside-app': { folder: 'required' },
  'folder-changed': { recorded: 'required', computed: 'required' },
  'unknown-key': { key: 'required' },
  'wrong-state': { key: 'required', state: 'required', pending: 'optional' },
  'prompt-not-taken': { key: 'required', state: 'required' },
  'prompt-too-long': { length: 'required', max: 'required' },
  'interrupt-unconfirmed': { key: 'required', state: 'required' },
  'agent-not-found': { command: 'required' },
  'agent-too-old': { found: 'required', oldestTested: 'required' },
  unobservable: { key: 'required', cause: 'required' },
  'session-cap-reached': { cap: 'required', live: 'required' },
  'unknown-id': { id: 'required' },
  'already-settled': { id: 'required', by: 'required' },
  'terminal-only': { id: 'required' },
  'invalid-answer': { id: 'required', issues: 'required' },
  'not-logged-in': {},
  'model-unavailable': { model: 'required' },
  'invalid-output': { issues: 'required', raw: 'required' },
  'api-error': { status: 'optional', detail: 'required' },
  refused: { cause: 'required' },
  'no-token': {},
  unreachable: {},
};

describe('docs/api.md and the entries', () => {
  it('documents the entries of the package, and no other', () => {
    expect(Object.keys(document.entries).sort()).toEqual(Object.keys(manifest.exports).sort());
  });

  it.each(entries)('lists every export of %s, and no other', (entry, index) => {
    const documented = (document.entries[entry] ?? []).map(({ name, kind }) => ({
      name,
      typeOnly: kind === 'type',
    }));

    expect(documented.sort(byName)).toEqual(readEntryExports(fileURLToPath(index)).sort(byName));
  });

  it.each(entries)('lists as values what %s exports at run time', async (entry, index) => {
    const documentedValues = (document.entries[entry] ?? [])
      .filter(({ kind }) => kind !== 'type')
      .map(({ name }) => name);

    expect(documentedValues.sort()).toEqual(Object.keys(await import(index.href)).sort());
  });

  it('names the kind of every export', () => {
    const kinds = Object.values(document.entries).flatMap((exports) =>
      exports.map(({ kind }) => kind),
    );

    expect(
      kinds.filter((kind) => !['class', 'function', 'constant', 'type'].includes(kind)),
    ).toEqual([]);
  });
});

describe('docs/api.md and the error codes', () => {
  it('lists every code, and no other', () => {
    expect(Object.keys(document.errors).sort()).toEqual(Object.keys(fieldsByCode).sort());
  });

  it.each(Object.entries(fieldsByCode))(
    'lists the fields of %s, required or optional as they are, and no other',
    (code, fields) => {
      expect(document.errors[code]).toEqual(fields);
    },
  );

  it('refuses a field on a code that has none', () => {
    const fields: (typeof fieldsByCode)['no-token'] = {
      // @ts-expect-error -- `no-token` carries no field
      bogus: 'required',
    };

    expect(Object.keys(fields)).toEqual(['bogus']);
  });
});

describe('the reader of docs/api.md', () => {
  it('tells an optional field, marked `?`, from a required one', () => {
    const folder = mkdtempSync(join(tmpdir(), 'cockpit-api-document-'));
    const path = join(folder, 'api.md');
    writeFileSync(
      path,
      [
        '## Errors',
        '',
        '| Code | Fields | When |',
        '| --- | --- | --- |',
        '| `api-error` | `status?`, `detail` | The `status` and `detail?` of a `code`. |',
        '| `no-token` | — | No token. |',
      ].join('\n'),
    );

    try {
      expect(readApiDocument(path).errors).toEqual({
        'api-error': { status: 'optional', detail: 'required' },
        'no-token': {},
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}
