import { type Dirent, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ENTRY_FOLDERS, PACKAGE_NAME } from './entries.ts';
import { type ModuleReference, readModuleReferences } from './module-references.ts';

/** One import that breaks a rule, or one file the rules cannot cover. */
export interface ImportViolation {
  /** The importing file, relative to the source root, with forward slashes. */
  file: string;
  /**
   * The module specifier; the expression as written when it is no literal;
   * empty when the file itself is the problem.
   */
  specifier: string;
  /** The rule broken, in words. */
  reason: string;
}

/** What one source folder may import. Its own files are always its to import. */
export interface FolderRule {
  /** The other source folders it may import. */
  folders: readonly string[];
  /** The packages it may import: names, or a whole scope as `@scope/*`. */
  packages: readonly string[];
  /** Whether it may import Node's built-in modules. */
  nodeBuiltins: boolean;
}

/**
 * The import rules: what each source folder may import, and nothing else. A
 * folder reaches no forbidden one through an allowed one, since every edge
 * of the way is checked against this table.
 *
 * - The core (`server/`) serves the channel through its runtime and knows no
 *   driver and no adapter; they import it, never the reverse.
 * - The channel's runtime stays separable from the core: it needs only the
 *   declaration, the shared code, zod and Node.
 * - The channel declaration and the shared code are imported on both sides,
 *   so they import neither, and no Node built-in.
 * - A browser bundle never pulls server code, a Node built-in or a package it
 *   does not need: the client takes none, the terminal only xterm.js.
 */
export const IMPORT_RULES: Readonly<Record<string, FolderRule>> = {
  server: {
    folders: ['channel-server', 'channel', 'shared'],
    packages: ['node-pty', 'ws', 'zod'],
    nodeBuiltins: true,
  },
  fastify: { folders: ['server', 'shared'], packages: ['fastify'], nodeBuiltins: true },
  'claude-code': { folders: ['server', 'shared'], packages: [], nodeBuiltins: true },
  'channel-server': { folders: ['channel', 'shared'], packages: ['zod'], nodeBuiltins: true },
  channel: { folders: ['shared'], packages: ['zod'], nodeBuiltins: false },
  shared: { folders: [], packages: [], nodeBuiltins: false },
  client: { folders: ['shared'], packages: [], nodeBuiltins: false },
  terminal: { folders: ['shared'], packages: ['@xterm/*'], nodeBuiltins: false },
};

const TYPESCRIPT_SOURCE = /\.(ts|tsx|mts|cts)$/;

/** A path, relative or absolute, as a module specifier. */
const PATH = /^(\.{1,2}(\/|$)|\/)/;

/** A package's name, with an optional scope, and an optional path inside the package. */
const PACKAGE = /^(@[a-z0-9-][a-z0-9._~-]*\/)?[a-z0-9-][a-z0-9._~-]*(\/.+)?$/;

/** A `.` or `..` segment, which would make a package's specifier name something else. */
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;

/**
 * Reads every import of every file under a source root and returns those
 * that break the import rules, in the order found. What the rules cannot
 * cover is a violation too: a file outside the folders they name (a new
 * folder needs a rule), a symbolic link, a file that is no TypeScript source,
 * and an import whose specifier is no literal or names nothing they know.
 */
export function findImportViolations(sourceRoot: string): ImportViolation[] {
  const entries = listEntries(sourceRoot);
  const references = readModuleReferences(
    entries.filter((entry) => entry.isFile() && TYPESCRIPT_SOURCE.test(entry.name)).map(pathOf),
  );

  return entries.flatMap((entry) => {
    const path = pathOf(entry);
    const file = relative(sourceRoot, path).split(sep).join('/');
    const folder = topFolder(file);
    const rule = folder === undefined ? undefined : IMPORT_RULES[folder];
    const referencesOfFile = references.get(path);
    if (!entry.isFile()) {
      return [aboutFile(file, 'it is a symbolic link or no regular file, so it cannot be checked')];
    }
    if (referencesOfFile === undefined) {
      return [
        aboutFile(file, 'the file is no TypeScript source, so its imports cannot be checked'),
      ];
    }
    if (folder === undefined || rule === undefined) {
      return [aboutFile(file, 'the file is in no folder the import rules name')];
    }
    return referencesOfFile.flatMap((reference) => {
      const reason = reasonAgainst(reference, { path, sourceRoot, folder, rule });
      return reason === undefined ? [] : [{ file, specifier: reference.text, reason }];
    });
  });
}

/** Everything under a folder but the folders themselves; a symbolic link is not followed. */
function listEntries(folder: string): Dirent[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => !entry.isDirectory())
    .sort((one, other) => (pathOf(one) < pathOf(other) ? -1 : 1));
}

function pathOf(entry: Dirent): string {
  return join(entry.parentPath, entry.name);
}

function aboutFile(file: string, reason: string): ImportViolation {
  return { file, specifier: '', reason };
}

function topFolder(file: string): string | undefined {
  const segments = file.split('/');
  return segments.length > 1 ? segments[0] : undefined;
}

interface Importer {
  path: string;
  sourceRoot: string;
  folder: string;
  rule: FolderRule;
}

function reasonAgainst(reference: ModuleReference, importer: Importer): string | undefined {
  const { folder, rule } = importer;
  const specifier = reference.text;
  if (!reference.literal) return 'the specifier is no literal, so the import cannot be checked';
  if (PATH.test(specifier)) return reasonAgainstPath(specifier, importer);
  if (specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`)) {
    return reasonAgainstEntry(specifier, importer);
  }
  if (isBuiltin(specifier)) {
    return rule.nodeBuiltins
      ? undefined
      : `${folder}/ must not import the Node built-in ${specifier}`;
  }
  if (!PACKAGE.test(specifier) || DOT_SEGMENT.test(specifier)) {
    return 'the specifier is no path, package or Node built-in, so the import cannot be checked';
  }
  const name = packageName(specifier);
  return allowsPackage(rule, name) ? undefined : `${folder}/ must not import the package ${name}`;
}

function reasonAgainstPath(specifier: string, importer: Importer): string | undefined {
  const target = relative(importer.sourceRoot, resolve(dirname(importer.path), specifier));
  if (target === '' || target.startsWith('..') || isAbsolute(target)) {
    return 'the import leaves the source root';
  }
  return reasonAgainstFolder(target.split(sep)[0] ?? target, importer);
}

/** An import of the package by its own name is an import of the entry's folder. */
function reasonAgainstEntry(specifier: string, importer: Importer): string | undefined {
  const folder = ENTRY_FOLDERS[`.${specifier.slice(PACKAGE_NAME.length)}`];
  return folder === undefined
    ? `the package has no entry ${specifier}`
    : reasonAgainstFolder(folder, importer);
}

function reasonAgainstFolder(imported: string, { folder, rule }: Importer): string | undefined {
  return imported === folder || rule.folders.includes(imported)
    ? undefined
    : `${folder}/ must not import ${imported}/`;
}

function packageName(specifier: string): string {
  const segments = specifier.split('/');
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

function allowsPackage(rule: FolderRule, name: string): boolean {
  return rule.packages.some((allowed) =>
    allowed.endsWith('/*') ? name.startsWith(allowed.slice(0, -1)) : name === allowed,
  );
}
