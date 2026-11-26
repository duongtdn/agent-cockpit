import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { toolUse, turn } from '../support/fake-api/index.ts';
import { BYPASS_ACCEPTED, SAID_KEY, startContractCockpit } from './cockpit-harness.ts';
import { toolResults } from './confinement-probes.ts';

/**
 * The `Edit` denies the driver writes on every settings file of Claude
 * Code's, on the real agent: in `bypassPermissions`, where nothing asks,
 * the file tools would otherwise write a settings file whose command hook
 * runs at the next start, outside any sandbox.
 */

/** What a settings file planted by the agent would hold: a hook that leaves a mark at each start. */
function planted(root: string, name: string): string {
  const mark = join(root, `planted-${name}`);
  return JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${mark}` }] }] },
  });
}

it("92 — In bypassPermissions, the driver's Edit denies on every Claude settings file hold: Write and Edit on the project's, the local, a folder above's local, a .claude folder's and the person's own settings are refused, and no planted hook runs at the next start", async () => {
  const cockpit = await startContractCockpit({
    driver: {
      permissionMode: 'bypassPermissions',
      permissions: { allow: ['Read', 'Write', 'Edit'] },
    },
    personsSettings: BYPASS_ACCEPTED,
    // A project in a git repository: the repository's own local settings are read too.
    directory: ({ workFolder }) => {
      execFileSync('git', ['init', '--quiet'], { cwd: workFolder });
      const project = join(workFolder, 'pkg');
      mkdirSync(join(project, '.claude'), { recursive: true });
      writeFileSync(join(project, '.claude', 'settings.json'), '{}');
      return project;
    },
  });
  const { root, configFolder, home } = cockpit;
  const project = join(cockpit.workFolder, '.claude', 'settings.json');
  const persons = join(configFolder, 'settings.json');
  const personsBefore = readFileSync(persons, 'utf8');
  const written = {
    local: join(cockpit.workFolder, '.claude', 'settings.local.json'),
    'repository-local': join(root, 'work', '.claude', 'settings.local.json'),
    home: join(home, '.claude', 'settings.json'),
    persons,
  };
  const calls = [
    toolUse('Read', { file_path: project }),
    toolUse('Edit', { file_path: project, old_string: '{}', new_string: planted(root, 'edit') }),
    toolUse('Read', { file_path: persons }),
    toolUse('Edit', {
      file_path: persons,
      old_string: personsBefore,
      new_string: planted(root, 'persons-edit'),
    }),
    ...Object.entries(written).map(([name, file_path]) =>
      toolUse('Write', { file_path, content: planted(root, name) }),
    ),
  ];
  cockpit.api.script(...calls.map((call) => turn(call)), turn('Done.'), turn('Again.'));

  await cockpit.say('plant the hooks');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const results = toolResults(cockpit.api);
  await cockpit.exitByItself(SAID_KEY, cockpit.conversationOf(SAID_KEY));
  await cockpit.say('start again', 'again');
  await cockpit.sessionIn('again', 'idle');

  expect(results).toHaveLength(calls.length);
  const [readProject, editProject, readPersons, editPersons, ...writes] = results;
  expect(readProject?.isError).toBe(false);
  expect(readPersons?.isError).toBe(false);
  for (const refused of [editProject, editPersons, ...writes]) {
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/denied/i) });
  }
  expect(readFileSync(project, 'utf8')).toBe('{}');
  expect(readFileSync(persons, 'utf8')).toBe(personsBefore);
  for (const file of Object.values(written).filter((file) => file !== persons)) {
    expect(existsSync(file), file).toBe(false);
  }
  expect(readdirSync(root).filter((name) => name.startsWith('planted-'))).toEqual([]);
});
