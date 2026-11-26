import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * This repository is public and reads on its own: nothing in it cites the
 * records its design was decided in elsewhere (architecture decisions, a
 * build's journal, process decisions), which no reader here can open. A
 * comment or a document says the fact in its own words instead.
 */

const REPOSITORY = join(import.meta.dirname, '..', '..');

/**
 * What the repository publishes or keeps for its readers, beside the
 * files of its root: code, tests, examples, documents, workflows.
 */
const SCANNED_FOLDERS: readonly string[] = ['src', 'test', 'examples', 'docs', '.github'];

/** What a build, an install or a test run leaves, which is not the repository's own. */
const LEFT_BY_TOOLS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  // Written by the package manager, whose hashes are no one's words.
  'pnpm-lock.yaml',
]);

/** What may stand between a record's name and its number: a hyphen or a space of any kind. */
const SEPARATOR = '[-_ \\u00a0\\u202f\\u2010-\\u2015\\u2212]';

/**
 * The citations of such records: an architecture decision's number, in any
 * case and by its path too (the folder `adr/` then the number); a
 * journal's entry and a process decision's, in capitals only, since
 * `dec-12` may be a date.
 */
const CITATIONS: readonly RegExp[] = [
  new RegExp(`\\bADR(?:${SEPARATOR}|/)?\\d{1,4}\\b`, 'giu'),
  new RegExp(`\\b(?:LD|DEC)${SEPARATOR}\\d{1,4}\\b`, 'gu'),
];

/** Every file the test reads: the root's own files, and those of its scanned folders. */
function scannedFiles(): string[] {
  const rootFiles = readdirSync(REPOSITORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !LEFT_BY_TOOLS.has(entry.name))
    .map((entry) => entry.name);
  return [...rootFiles, ...SCANNED_FOLDERS.flatMap(filesUnder)];
}

/** Every file under a path of the repository, by its path from the repository. */
function filesUnder(path: string): string[] {
  const absolute = join(REPOSITORY, path);
  const status = lstatSync(absolute, { throwIfNoEntry: false });
  if (status === undefined) return [];
  if (!status.isDirectory()) return [path];
  return readdirSync(absolute)
    .filter((name) => !LEFT_BY_TOOLS.has(name))
    .flatMap((name) => filesUnder(join(path, name)));
}

/** The citations in a text, each as `<file>:<line>: <citation>`. */
function citationsIn(file: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, index) =>
      CITATIONS.flatMap((citation) =>
        [...line.matchAll(citation)].map(([cited]) => `${file}:${index + 1}: ${cited}`),
      ),
    );
}

function isText(content: Buffer): boolean {
  return !content.includes(0);
}

describe('the public repository', () => {
  it("cites no record of the decisions made elsewhere, in code, tests, examples, documents or the root's files", () => {
    const citations = scannedFiles().flatMap((file) => {
      const content = readFileSync(join(REPOSITORY, file));
      return isText(content) ? citationsIn(relative('.', file), content.toString('utf8')) : [];
    });

    expect(citations).toEqual([]);
  });

  it.each([
    ['an architecture decision', ['ADR', '0086'].join('-')],
    ['an architecture decision, spaced', ['ADR', '0086'].join(' ')],
    ['an architecture decision, run together', ['ADR', '0086'].join('')],
    ['an architecture decision, in lower case', ['adr', '0086'].join('-')],
    ['an architecture decision, in mixed case', ['Adr', '0086'].join('-')],
    ['an architecture decision, by its path', ['docs/adr', '0086-a-title.md'].join('/')],
    ['an architecture decision, with an en dash', ['ADR', '0086'].join('\u2013')],
    ['an architecture decision, with a non-breaking hyphen', ['ADR', '0086'].join('\u2011')],
    ['an architecture decision, with a non-breaking space', ['ADR', '0086'].join('\u00a0')],
    ['a journal entry', ['LD', '054'].join('-')],
    ['a journal entry, spaced', ['LD', '054'].join(' ')],
    ['a journal entry, with an en dash', ['LD', '054'].join('\u2013')],
    ['a journal entry, with a non-breaking hyphen', ['LD', '054'].join('\u2011')],
    ['a process decision', ['DEC', '012'].join('-')],
    ['a process decision, spaced', ['DEC', '012'].join(' ')],
    ['a process decision, with an en dash', ['DEC', '012'].join('\u2013')],
    ['a process decision, with a non-breaking hyphen', ['DEC', '012'].join('\u2011')],
  ])('finds %s cited', (_, cited) => {
    expect(citationsIn('a.ts', `// As ${cited} says.`)).toHaveLength(1);
  });

  it('says where each citation is, and what it cites', () => {
    const cited = ['ADR', '0086'].join('-');

    expect(citationsIn('a.ts', `one\nAs ${cited} says.`)).toEqual([`a.ts:2: ${cited}`]);
  });

  it('finds no citation in words that only begin alike', () => {
    expect(citationsIn('a.ts', 'ADRESS, address 12, OLD-style, DECIDED, a LD-xyz label')).toEqual(
      [],
    );
  });

  it.each([
    ['a date in lower case', ['dec', '12'].join('-')],
    ['a date in title case', 'Dec 12, 2026'],
    ['an ISO date', '2026-11-27'],
    ['a version', 'v0.12.3, Node 22.18'],
    ['a decimal', '0.0086'],
    ['a journal entry in lower case, which is no record', ['ld', '054'].join('-')],
  ])('finds no citation in %s', (_, text) => {
    expect(citationsIn('a.ts', text)).toEqual([]);
  });

  it("scans the root's own files: the package, the configurations, the documents", () => {
    expect(scannedFiles()).toEqual(
      expect.arrayContaining([
        'package.json',
        'biome.json',
        'tsconfig.json',
        'tsconfig.base.json',
        'vitest.config.ts',
        'pnpm-workspace.yaml',
        'README.md',
        join('src', 'server', 'index.ts'),
      ]),
    );
  });
});
