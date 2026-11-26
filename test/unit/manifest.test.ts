import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENTRY_FOLDERS } from '../support/entries.ts';

const root = new URL('../../', import.meta.url);

function readJson(file: string) {
  return JSON.parse(readFileSync(new URL(file, root), 'utf8'));
}

const manifest = readJson('package.json');

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

describe('package.json', () => {
  it('describes one ESM package for Node 22 or later, under MIT', () => {
    expect(manifest).toMatchObject({
      name: '@duongtdn/agent-cockpit',
      type: 'module',
      engines: { node: '>=22' },
      license: 'MIT',
      sideEffects: false,
    });
  });

  it('pins the package manager to one pnpm version', () => {
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('ships the build, the license, the readme and the changelog', () => {
    expect(manifest.files).toEqual(['dist', 'LICENSE', 'README.md', 'CHANGELOG.md']);
  });

  it('has the six entries, and no other', () => {
    expect(Object.keys(manifest.exports)).toEqual(Object.keys(ENTRY_FOLDERS));
  });

  it.each(Object.entries(ENTRY_FOLDERS))(
    'points the entry %s at the build of src/%s, types first',
    (entry, folder) => {
      expect(Object.entries(manifest.exports[entry])).toEqual([
        ['types', `./dist/${folder}/index.d.ts`],
        ['import', `./dist/${folder}/index.js`],
      ]);
      expect(existsSync(new URL(`src/${folder}/index.ts`, root))).toBe(true);
    },
  );

  it('depends at run time on node-pty, ws and xterm.js only', () => {
    const names = Object.keys(manifest.dependencies);

    expect(names).toEqual(expect.arrayContaining(['node-pty', 'ws', '@xterm/xterm']));
    expect(names.filter((name) => !['node-pty', 'ws'].includes(name))).toSatisfy(
      (others: string[]) => others.every((name) => name.startsWith('@xterm/')),
    );
  });

  it('pins every dependency, run time and development, to an exact version', () => {
    const versions = Object.entries<string>({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    expect(versions.filter(([, version]) => !EXACT_VERSION.test(version))).toEqual([]);
  });

  it('takes zod 4 as a peer, and Fastify as an optional one', () => {
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(['fastify', 'zod']);
    expect(manifest.peerDependencies.zod).toBe('^4');
    expect(manifest.peerDependenciesMeta).toEqual({ fastify: { optional: true } });
  });

  it.each(['build', 'typecheck', 'lint', 'test', 'test:integration', 'test:contract', 'check'])(
    'has the script %s',
    (script) => {
      expect(manifest.scripts[script]).toEqual(expect.any(String));
    },
  );
});

describe('the check script and CI', () => {
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const scriptsOfCheck = [...manifest.scripts.check.matchAll(/pnpm ([a-z:]+)/g)].map(
    ([, script]) => script,
  );
  const scriptsOfCi = [...workflow.matchAll(/run: pnpm ([a-z:]+)$/gm)]
    .map(([, script]) => script)
    .filter((script) => script !== 'install');

  it('check typechecks, lints, tests, builds and packs', () => {
    expect(scriptsOfCheck).toEqual([
      'typecheck',
      'lint',
      'test',
      'test:integration',
      'build',
      'test:pack',
    ]);
  });

  it('CI runs the steps of check, in its order', () => {
    expect(scriptsOfCi).toEqual(scriptsOfCheck);
  });

  it('CI installs with the lockfile frozen', () => {
    expect(workflow).toContain('pnpm install --frozen-lockfile');
  });

  it('CI installs tmux and what node-pty needs to compile', () => {
    const [, packages = ''] = /apt-get install --yes (.+)$/m.exec(workflow) ?? [];

    expect(packages.split(' ')).toEqual(
      expect.arrayContaining(['tmux', 'build-essential', 'python3']),
    );
  });

  it('CI uses no secret', () => {
    expect(workflow).not.toContain('secrets.');
  });
});

describe('the TypeScript configurations', () => {
  it('are strict, with checked index access and exact optional properties, on NodeNext', () => {
    expect(readJson('tsconfig.base.json').compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
    });
  });

  it('check browser code against the DOM library, without Node types', () => {
    const { compilerOptions, include } = readJson('tsconfig.browser.json');

    expect(compilerOptions.lib).toContain('DOM');
    expect(compilerOptions.types).toEqual([]);
    expect(include).toEqual(expect.arrayContaining(['src/client', 'src/terminal']));
  });

  it('check server code against Node types, without the DOM library', () => {
    const { compilerOptions, include } = readJson('tsconfig.server.json');

    expect(compilerOptions.lib).not.toContain('DOM');
    expect(compilerOptions.types).toEqual(['node']);
    expect(include).toEqual(
      expect.arrayContaining([
        'src/server',
        'src/fastify',
        'src/claude-code',
        'src/channel-server',
      ]),
    );
  });

  it('check the code of both sides under both', () => {
    for (const file of ['tsconfig.browser.json', 'tsconfig.server.json']) {
      expect(readJson(file).include).toEqual(expect.arrayContaining(['src/channel', 'src/shared']));
    }
  });

  it('build dist/ as a mirror of src/', () => {
    expect(readJson('tsconfig.build.json')).toMatchObject({
      compilerOptions: { rootDir: 'src', outDir: 'dist', declaration: true },
      include: ['src'],
    });
  });
});
