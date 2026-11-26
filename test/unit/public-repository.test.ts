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

/** What the repository publishes or keeps for its readers: code, tests, examples, documents. */
const SCANNED: readonly string[] = [
  'src',
  'test',
  'examples',
  'docs',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  '.github',
];

/** What a build, an install or a test run leaves, which is not the repository's own. */
const LEFT_BY_TOOLS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test-results',
]);

/** A citation of such a record: an architecture decision's number, a journal's entry, a process decision's. */
const CITATION = /\b(?:ADR[- ]?\d{1,4}|LD-\d{1,4}|DEC-\d{1,4})\b/g;

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
      [...line.matchAll(CITATION)].map(([cited]) => `${file}:${index + 1}: ${cited}`),
    );
}

function isText(content: Buffer): boolean {
  return !content.includes(0);
}

describe('the public repository', () => {
  it('cites no record of the decisions made elsewhere, in code, tests, examples or documents', () => {
    const citations = SCANNED.flatMap(filesUnder).flatMap((file) => {
      const content = readFileSync(join(REPOSITORY, file));
      return isText(content) ? citationsIn(relative('.', file), content.toString('utf8')) : [];
    });

    expect(citations).toEqual([]);
  });

  it.each([
    ['an architecture decision', ['ADR', '0086'].join('-')],
    ['an architecture decision, spaced', ['ADR', '0086'].join(' ')],
    ['a journal entry', ['LD', '054'].join('-')],
    ['a process decision', ['DEC', '012'].join('-')],
  ])('finds %s cited', (_, cited) => {
    expect(citationsIn('a.ts', `// As ${cited} says.`)).toEqual([`a.ts:1: ${cited}`]);
  });

  it('finds no citation in words that only begin alike', () => {
    expect(citationsIn('a.ts', 'ADRESS, OLD-style, DECIDED, a LD-xyz label')).toEqual([]);
  });
});
