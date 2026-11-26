import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findImportViolations, IMPORT_RULES } from '../support/import-rules.ts';

const realSource = fileURLToPath(new URL('../../src', import.meta.url));
const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));

/** Every import between two source folders that must fail, by importing folder. */
const FORBIDDEN_FOLDERS: Record<string, readonly string[]> = {
  server: ['fastify', 'claude-code', 'client', 'terminal'],
  fastify: ['claude-code', 'channel-server', 'channel', 'client', 'terminal'],
  'claude-code': ['fastify', 'channel-server', 'channel', 'client', 'terminal'],
  'channel-server': ['server', 'fastify', 'claude-code', 'client', 'terminal'],
  channel: ['server', 'fastify', 'claude-code', 'channel-server', 'client', 'terminal'],
  shared: ['server', 'fastify', 'claude-code', 'channel-server', 'channel', 'client', 'terminal'],
  client: ['server', 'fastify', 'claude-code', 'channel-server', 'channel', 'terminal'],
  terminal: ['server', 'fastify', 'claude-code', 'channel-server', 'channel', 'client'],
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-import-rules-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function plant(file: string, content: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('the import rules, on the real source', () => {
  it('finds no forbidden import in src/', () => {
    expect(findImportViolations(realSource)).toEqual([]);
  });
});

describe('the import rules, on planted files', () => {
  it.each(
    Object.entries(FORBIDDEN_FOLDERS).flatMap(([folder, forbidden]) =>
      forbidden.map((imported) => [`${folder}/x.ts`, `../${imported}/index.js`, imported]),
    ),
  )('reports %s importing %s', (file, specifier, imported) => {
    plant(file, `import { something } from '${specifier}';\n`);

    expect(findImportViolations(root)).toEqual([
      { file, specifier, reason: `${dirname(file)}/ must not import ${imported}/` },
    ]);
  });

  it('names every folder of the rules in the forbidden imports it plants', () => {
    expect(Object.keys(FORBIDDEN_FOLDERS).sort()).toEqual(Object.keys(IMPORT_RULES).sort());
  });

  it('reports a forbidden folder reached through an allowed one at its first forbidden import', () => {
    plant('server/x.ts', "import { adapter } from '../fastify/index.js';\n");
    plant('fastify/index.ts', "export { driver as adapter } from '../claude-code/index.js';\n");

    expect(findImportViolations(root)).toEqual([
      {
        file: 'fastify/index.ts',
        specifier: '../claude-code/index.js',
        reason: 'fastify/ must not import claude-code/',
      },
      {
        file: 'server/x.ts',
        specifier: '../fastify/index.js',
        reason: 'server/ must not import fastify/',
      },
    ]);
  });

  it('reads files in nested folders, by the top folder on each end', () => {
    plant('client/live/socket.ts', "import { host } from '../../server/host/tmux.js';\n");

    expect(findImportViolations(root)).toMatchObject([
      { file: 'client/live/socket.ts', specifier: '../../server/host/tmux.js' },
    ]);
  });

  it.each([
    ['client/x.ts', '@duongtdn/agent-cockpit'],
    ['server/x.ts', '@duongtdn/agent-cockpit/claude-code'],
  ])('treats %s importing the entry %s as importing its folder', (file, specifier) => {
    plant(file, `import { something } from '${specifier}';\n`);

    expect(findImportViolations(root)).toMatchObject([{ file, specifier }]);
  });

  it('reports every forbidden import of a file', () => {
    plant(
      'shared/x.ts',
      "import { a } from '../server/a.js';\nimport { b } from '../client/b.js';\n",
    );

    expect(findImportViolations(root).map((violation) => violation.specifier)).toEqual([
      '../server/a.js',
      '../client/b.js',
    ]);
  });

  it('reports a file in a folder that has no rule', () => {
    plant('extras/x.ts', "import { a } from '../shared/a.js';\n");
    plant('loose.ts', 'export const loose = 1;\n');

    expect(findImportViolations(root).map((violation) => violation.file)).toEqual([
      'extras/x.ts',
      'loose.ts',
    ]);
  });

  it('accepts the imports the rules allow', () => {
    plant(
      'server/x.ts',
      [
        "import { handler } from '../channel-server/handler.js';",
        "import { declare } from '../channel/index.js';",
        "import { CockpitError } from '../shared/cockpit-error.js';",
        "import { spawn } from 'node-pty';",
        "import { WebSocketServer } from 'ws';",
        "import { createServer } from 'node:http';",
      ].join('\n'),
    );
    plant(
      'channel-server/x.ts',
      [
        "import { declare } from '../channel/index.js';",
        "import { CockpitError } from '../shared/cockpit-error.js';",
        "import { registry } from './registry.js';",
        "import { createServer } from 'node:http';",
        "import { randomUUID } from 'crypto';",
        "import { z } from 'zod';",
        "import { core } from 'zod/v4/core';",
      ].join('\n'),
    );
    plant(
      'channel/x.ts',
      "import { z } from 'zod';\nimport type { W } from '../shared/wire.js';\n",
    );
    plant('shared/x.ts', "import type { Y } from './y.js';\n");
    plant('client/x.ts', "import { W } from '../shared/wire.js';\nimport { c } from './c.js';\n");
    plant(
      'terminal/x.ts',
      "import { Terminal } from '@xterm/xterm';\nimport { W } from '../shared/wire.js';\n",
    );
    plant(
      'claude-code/x.ts',
      [
        "import type { Driver } from '../server/driver.js';",
        "import { CockpitError } from '../shared/cockpit-error.js';",
      ].join('\n'),
    );
    plant(
      'fastify/x.ts',
      [
        "import type { Core } from '../server/core.js';",
        "import { CockpitError } from '../shared/cockpit-error.js';",
        "import 'fastify';",
      ].join('\n'),
    );

    expect(findImportViolations(root)).toEqual([]);
  });

  it('accepts the built-ins and the packages each folder may use', () => {
    plant('channel-server/x.ts', "import 'node:http';\nimport 'crypto';\nimport 'zod';\n");
    plant('channel/x.ts', "import 'zod';\nimport 'zod/v4/core';\n");
    plant('terminal/x.ts', "import '@xterm/xterm';\nimport '@xterm/addon-fit';\n");
    plant(
      'server/x.ts',
      "import 'node:fs';\nimport 'fs';\nimport 'ws';\nimport 'node-pty';\nimport 'zod';\n",
    );
    plant('claude-code/x.ts', "import 'node:child_process';\nimport 'child_process';\n");
    plant('fastify/x.ts', "import 'node:http';\nimport 'fastify';\n");

    expect(findImportViolations(root)).toEqual([]);
  });

  it.each([
    ['client/x.ts', 'zod', /package zod/],
    ['client/x.ts', 'ws', /package ws/],
    ['client/x.ts', '@xterm/xterm', /package @xterm\/xterm/],
    ['client/x.ts', 'node:fs', /built-in/],
    ['client/x.ts', 'fs', /built-in/],
    ['client/x.ts', 'crypto', /built-in/],
    ['terminal/x.ts', 'zod', /package zod/],
    ['terminal/x.ts', 'ws', /package ws/],
    ['terminal/x.ts', 'xterm', /package xterm/],
    ['terminal/x.ts', 'node:path', /built-in/],
    ['terminal/x.ts', 'path', /built-in/],
    ['shared/x.ts', 'zod', /package zod/],
    ['shared/x.ts', 'node:events', /built-in/],
    ['shared/x.ts', 'events', /built-in/],
    ['channel/x.ts', 'ws', /package ws/],
    ['channel/x.ts', '@xterm/xterm', /package @xterm\/xterm/],
    ['channel/x.ts', 'node:crypto', /built-in/],
    ['channel/x.ts', 'crypto', /built-in/],
    ['channel-server/x.ts', 'node-pty', /package node-pty/],
    ['channel-server/x.ts', 'ws', /package ws/],
    ['channel-server/x.ts', 'fastify', /package fastify/],
    ['channel-server/x.ts', '@scope/package/deep.js', /package @scope\/package/],
    ['server/x.ts', 'fastify', /package fastify/],
    ['server/x.ts', '@xterm/xterm', /package @xterm\/xterm/],
    ['server/x.ts', 'express', /package express/],
    ['server/x.ts', 'typescript', /package typescript/],
    ['fastify/x.ts', 'ws', /package ws/],
    ['fastify/x.ts', 'node-pty', /package node-pty/],
    ['fastify/x.ts', 'zod', /package zod/],
    ['fastify/x.ts', 'express', /package express/],
    ['claude-code/x.ts', 'zod', /package zod/],
    ['claude-code/x.ts', 'ws', /package ws/],
    ['claude-code/x.ts', 'node-pty', /package node-pty/],
    ['claude-code/x.ts', 'fastify', /package fastify/],
  ])('reports %s importing %s', (file, specifier, reason) => {
    plant(file, `import { something } from '${specifier}';\n`);

    expect(findImportViolations(root)).toEqual([
      { file, specifier, reason: expect.stringMatching(reason) },
    ]);
  });

  it.each([
    ['client/x.ts', '../../dist/server/index.js'],
    ['server/x.ts', '../../package.json'],
    ['shared/deep/x.ts', '../../../node_modules/ws/index.js'],
    ['server/x.ts', '..'],
    ['server/x.ts', '/etc/cockpit/core.js'],
  ])('reports %s importing %s, which leaves the source root', (file, specifier) => {
    plant(file, `import { something } from '${specifier}';\n`);

    expect(findImportViolations(root)).toEqual([
      { file, specifier, reason: expect.stringMatching(/leaves the source root/) },
    ]);
  });

  it('follows a path that leaves the source root and comes back', () => {
    plant('client/x.ts', `import { core } from '../../${basename(root)}/server/core.js';\n`);

    expect(findImportViolations(root)).toMatchObject([
      { reason: 'client/ must not import server/' },
    ]);
  });

  it.each([
    ['file:///etc/cockpit/core.js'],
    ['https://example.com/core.js'],
    ['#core'],
    ['node:no-such-module'],
    ['zod/../ws'],
    ['zod/./v4'],
    ['zod/..'],
    ['~/core'],
    ['@/core'],
    ['~'],
  ])('reports the specifier %s, which it cannot place', (specifier) => {
    plant('server/x.ts', `import { something } from '${specifier}';\n`);

    expect(findImportViolations(root)).toEqual([
      { file: 'server/x.ts', specifier, reason: expect.stringMatching(/cannot be checked/) },
    ]);
  });

  it('names only packages the manifest declares, and every one of them', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
    const named = Object.values(IMPORT_RULES).flatMap((rule) => rule.packages);
    const namedBy = (name: string) =>
      named.filter((allowed) =>
        allowed.endsWith('/*') ? name.startsWith(allowed.slice(0, -1)) : name === allowed,
      );

    expect(declared.filter((name) => namedBy(name).length === 0)).toEqual([]);
    expect(
      named.filter((allowed) => !declared.some((name) => namedBy(name).includes(allowed))),
    ).toEqual([]);
  });

  it('reports an entry the package does not have', () => {
    plant('server/x.ts', "import { something } from '@duongtdn/agent-cockpit/nowhere';\n");

    expect(findImportViolations(root)).toMatchObject([
      { reason: expect.stringMatching(/no entry/) },
    ]);
  });
});

describe('the import rules, on every way to write an import', () => {
  it.each([
    ['a type-only import', "import type { Core } from '../server/core.js';"],
    ['an inline type import', "import { type Core } from '../server/core.js';"],
    ['a default import', "import core from '../server/core.js';"],
    ['a namespace import', "import * as core from '../server/core.js';"],
    ['a re-export', "export { core } from '../server/core.js';"],
    ['a re-export of types', "export type { Core } from '../server/core.js';"],
    ['a re-export of everything', "export * from '../server/core.js';"],
    ['a re-export under a name', "export * as core from '../server/core.js';"],
    ['an import for its effects', "import '../server/core.js';"],
    ['a dynamic import', "const core = await import('../server/core.js');"],
    ['a dynamic import of a template', 'const core = await import(`../server/core.js`);'],
    ['a dynamic import in a function', "function load() { return import('../server/core.js'); }"],
    ['a require call', "const core = require('../server/core.js');"],
    ['a require call of a template', 'const core = require(`../server/core.js`);'],
    ['an import by require', "import core = require('../server/core.js');"],
    ['an import type', "export type Core = import('../server/core.js').Core;"],
    ['a typeof import type', "export type Core = typeof import('../server/core.js');"],
    ['an import over several lines', "import {\n  core,\n  other,\n} from '../server/core.js';"],
    ['an import in double quotes', 'import { core } from "../server/core.js";'],
    ['an import with no space', "import{core}from'../server/core.js';"],
    ['an import with attributes', "import data from '../server/core.js' with { type: 'json' };"],
    [
      'an import with comments between its words',
      "import /* a */ { core } /* b */ from /* c */ '../server/core.js';",
    ],
    [
      'a re-export with a line comment before its specifier',
      "export { core } from // why\n  '../server/core.js';",
    ],
    [
      'a dynamic import with a comment in its call',
      "const core = await import(/* chunk: core */ '../server/core.js');",
    ],
    [
      'a dynamic import broken over lines and comments',
      "const core = await import // a\n/* b */ (\n  // c\n  '../server/core.js'\n);",
    ],
    [
      'a require call with comments',
      "const core = require /* a */ (/* b */ '../server/core.js' /* c */);",
    ],
    ['an import with an escape in its specifier', "import '../server/c\\u006fre.js';"],
  ])('reads %s', (_form, content) => {
    plant('client/x.ts', `${content}\n`);

    expect(findImportViolations(root)).toEqual([
      {
        file: 'client/x.ts',
        specifier: '../server/core.js',
        reason: 'client/ must not import server/',
      },
    ]);
  });

  it.each([
    ['a dynamic import of a name', 'const core = await import(name);', 'name'],
    [
      'a dynamic import of a template with a substitution',
      'const core = await import(`../server/${' + 'name}.js`);',
      '`../server/${' + 'name}.js`',
    ],
    [
      'a dynamic import of a concatenation',
      "const core = await import('../ser' + 'ver/core.js');",
      "'../ser' + 'ver/core.js'",
    ],
    ['a require call of a name', 'const core = require(name);', 'name'],
  ])('reports %s, which it cannot check', (_form, content, written) => {
    plant('server/x.ts', `const name = 'core';\n${content}\n`);

    expect(findImportViolations(root)).toEqual([
      { file: 'server/x.ts', specifier: written, reason: expect.stringMatching(/no literal/) },
    ]);
  });

  it.each([
    [
      'a documentation comment',
      "/**\n * @example\n * import { core } from '../server/core.js';\n */",
    ],
    ['a line comment', "// import { core } from '../server/core.js';"],
    ['a block comment', "/* const core = await import('../server/core.js'); */"],
    ['a string that reads like an import', 'export const hint = "read from \'disk\'";'],
    ['a string that holds an import', 'export const hint = "import(\'../server/core.js\')";'],
    ['a string that holds a require', 'export const hint = \'require("../server/core.js")\';'],
    [
      'a template that holds an import',
      "export const hint = `import { core } from '../server/core.js';`;",
    ],
    [
      'a template with a substitution around an import',
      'export const hint = `${' + "1} import('../server/core.js') ${" + '2}`;',
    ],
    ['a regular expression', "export const pattern = /from '..\\/server\\/core.js'/;"],
    ['a method named require', "export const core = loader.require('../server/core.js');"],
    ['a method named import', "export const core = loader.import('../server/core.js');"],
    ['a property named from', "export const core = { from: '../server/core.js' };"],
  ])('ignores %s', (_form, content) => {
    plant('client/x.ts', `${content}\nexport const loader = undefined as never;\n`);

    expect(findImportViolations(root)).toEqual([]);
  });

  it('ignores the text of a JSX element', () => {
    plant(
      'client/x.tsx',
      "export const hint = <p title=\"from '../server/a.js'\">import('../server/b.js')</p>;\n",
    );

    expect(findImportViolations(root)).toEqual([]);
  });
});

describe('the import rules, on triple-slash references', () => {
  it.each([
    ['client/x.ts', '/// <reference types="node" />', 'node', /package node/],
    ['shared/x.ts', '/// <reference types="zod" />', 'zod', /package zod/],
    ['server/x.ts', '/// <reference types="zod/../ws" />', 'zod/../ws', /cannot be checked/],
    [
      'client/x.ts',
      '/// <reference path="../server/core.d.ts" />',
      '../server/core.d.ts',
      /client\/ must not import server\//,
    ],
    [
      'client/x.ts',
      '/// <reference path="../../outside.d.ts" />',
      '../../outside.d.ts',
      /leaves the source root/,
    ],
  ])('reports %s holding %s', (file, directive, specifier, reason) => {
    plant(file, `${directive}\nexport const x = 1;\n`);

    expect(findImportViolations(root)).toEqual([
      { file, specifier, reason: expect.stringMatching(reason) },
    ]);
  });

  it("reads a path with no leading dot from the file's own folder", () => {
    plant('client/x.ts', '/// <reference path="server/core.d.ts" />\nexport const x = 1;\n');
    plant('client/deep/y.ts', '/// <reference path="zod" />\nexport const y = 1;\n');

    expect(findImportViolations(root)).toEqual([]);
  });

  it('accepts the references the rules allow', () => {
    plant(
      'channel/x.ts',
      '/// <reference types="zod" />\n/// <reference path="../shared/wire.d.ts" />\nexport const x = 1;\n',
    );

    expect(findImportViolations(root)).toEqual([]);
  });

  it('ignores a reference that a comment or a string holds', () => {
    plant(
      'client/x.ts',
      [
        'export const x = 1;',
        '// /// <reference types="node" />',
        '/* /// <reference path="../server/core.d.ts" /> */',
        'export const hint = \'/// <reference types="node" />\';',
      ].join('\n'),
    );

    expect(findImportViolations(root)).toEqual([]);
  });
});

describe('the import rules, on every kind of file', () => {
  it('reports a symbolic link to a file, which it does not follow', () => {
    plant('server/core.ts', 'export const core = 1;\n');
    plant('client/x.ts', 'export const x = 1;\n');
    symlinkSync(join(root, 'server/core.ts'), join(root, 'client/core.ts'));

    expect(findImportViolations(root)).toEqual([
      { file: 'client/core.ts', specifier: '', reason: expect.stringMatching(/symbolic link/) },
    ]);
  });

  it('reports a symbolic link to a folder, which it does not follow', () => {
    plant('server/core.ts', 'export const core = 1;\n');
    plant('client/x.ts', 'export const x = 1;\n');
    symlinkSync(join(root, 'server'), join(root, 'client/linked'));

    expect(findImportViolations(root)).toEqual([
      { file: 'client/linked', specifier: '', reason: expect.stringMatching(/symbolic link/) },
    ]);
  });

  it('reports a symbolic link whose name ends like a TypeScript source', () => {
    plant('client/x.ts', 'export const x = 1;\n');
    symlinkSync(join(root, 'nowhere.ts'), join(root, 'client/dangling.ts'));

    expect(findImportViolations(root)).toEqual([
      { file: 'client/dangling.ts', specifier: '', reason: expect.stringMatching(/symbolic link/) },
    ]);
  });

  it.each(['x.ts', 'x.tsx', 'x.mts', 'x.cts', 'x.d.ts', 'x.d.mts'])('reads client/%s', (name) => {
    plant(`client/${name}`, "import type { Core } from '../server/core.js';\n");

    expect(findImportViolations(root)).toEqual([
      {
        file: `client/${name}`,
        specifier: '../server/core.js',
        reason: 'client/ must not import server/',
      },
    ]);
  });

  it.each(['x.js', 'x.mjs', 'x.cjs', 'x.jsx', 'notes.md', 'data.json', 'Makefile'])(
    'reports client/%s, which is no TypeScript source',
    (name) => {
      plant(`client/${name}`, "import { core } from '../server/core.js';\n");

      expect(findImportViolations(root)).toEqual([
        { file: `client/${name}`, specifier: '', reason: expect.stringMatching(/TypeScript/) },
      ]);
    },
  );

  it('finds nothing in an empty source root', () => {
    expect(findImportViolations(root)).toEqual([]);
  });
});
