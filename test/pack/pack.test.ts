import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

/** The environment without the settings pnpm passes to its scripts, which npm warns about. */
function environmentForNpm(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_config_')),
  );
}

/** The files `npm pack` would put in the tarball, from the build in `dist/`. */
function listPackedFiles(): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    env: environmentForNpm(),
  });
  const [tarball] = JSON.parse(output) as [{ files: { path: string }[] }];
  return tarball.files.map((file) => file.path);
}

describe('what npm pack would ship', () => {
  const files = listPackedFiles();

  it('is the build, the license, the readme, the changelog and the manifest only', () => {
    const others = files.filter((file) => !file.startsWith('dist/')).sort();

    expect(others).toEqual(['CHANGELOG.md', 'LICENSE', 'README.md', 'package.json']);
  });

  it('holds the code and the types of every entry', () => {
    const targets = Object.values<{ types: string; import: string }>(manifest.exports).flatMap(
      (target) => [target.types, target.import].map((path) => path.replace('./', '')),
    );

    expect(files).toEqual(expect.arrayContaining(targets));
  });

  it('holds no test and no source', () => {
    expect(files.filter((file) => /\.test\.|\.ts$/.test(file) && !file.endsWith('.d.ts'))).toEqual(
      [],
    );
  });
});
