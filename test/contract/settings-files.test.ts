import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { eventually } from '../support/eventually.ts';
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

/** What a file of MCP servers planted by the agent would hold: a server, a program that leaves a mark at each start. */
function plantedServers(root: string, name: string): Record<string, unknown> {
  const mark = join(root, `planted-${name}`);
  // Each of its own name: of two servers of a name, the agent starts one.
  return { [`planted-${name}`]: { command: '/bin/sh', args: ['-c', `touch ${mark}`] } };
}

it("96 — In bypassPermissions, the driver's Edit denies on every file that gives the agent MCP servers hold: Write on a project's .mcp.json, the configuration folder's .claude.json and the home's is refused, and no planted server runs at the next start", async () => {
  const cockpit = await startContractCockpit({
    driver: {
      permissionMode: 'bypassPermissions',
      permissions: { allow: ['Read', 'Write', 'Edit'] },
    },
    personsSettings: BYPASS_ACCEPTED,
  });
  const { root, configFolder, home } = cockpit;
  const configuration = join(configFolder, '.claude.json');
  const configurationBefore = readFileSync(configuration, 'utf8');
  const written = {
    project: {
      file: join(cockpit.workFolder, '.mcp.json'),
      content: { mcpServers: plantedServers(root, 'project') },
    },
    // The agent's own configuration, the recipe kept, so the next start shows no dialog.
    configuration: {
      file: configuration,
      content: {
        ...JSON.parse(configurationBefore),
        mcpServers: plantedServers(root, 'configuration'),
      },
    },
    // The pinned agent reads the home's when no configuration folder is named (a cockpit's
    // launch may name none), the configuration folder's otherwise, as here: the refusal holds it.
    home: {
      file: join(home, '.claude.json'),
      content: { mcpServers: plantedServers(root, 'home') },
    },
  };
  const calls = Object.values(written).map(({ file, content }) =>
    toolUse('Write', { file_path: file, content: JSON.stringify(content) }),
  );
  cockpit.api.script(...calls.map((call) => turn(call)), turn('Done.'), turn('Again.'));

  await cockpit.say('plant the servers');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const results = toolResults(cockpit.api);
  // Killed: an agent that exits saves its own configuration over the file, a planted server lost.
  await cockpit.killAgent(SAID_KEY);
  await cockpit.say('start again', 'again');
  await cockpit.sessionIn('again', 'idle');

  expect(results).toHaveLength(calls.length);
  for (const refused of results) {
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/denied/i) });
  }
  expect(existsSync(written.project.file)).toBe(false);
  expect(existsSync(written.home.file)).toBe(false);
  expect(JSON.parse(readFileSync(configuration, 'utf8'))).not.toHaveProperty('mcpServers');
  expect(readdirSync(root).filter((name) => name.startsWith('planted-'))).toEqual([]);
});

/** When the person's plugin was installed: any time before the test. */
const INSTALLED_AT = '2026-11-01T00:00:00.000Z';

it("97 — In bypassPermissions, the driver's Edit deny on the person's plugins holds: Write of a hook into an enabled plugin is refused, and no planted hook runs at the next start", async () => {
  const cockpit = await startContractCockpit({
    driver: {
      permissionMode: 'bypassPermissions',
      permissions: { allow: ['Read', 'Write', 'Edit'] },
    },
    personsSettings: { ...BYPASS_ACCEPTED, enabledPlugins: { 'probe@local': true } },
  });
  const { root } = cockpit;
  // A plugin the person installed and enabled, from a marketplace that is a folder: the agent
  // loads it from the marketplace's folder at each start.
  const plugins = join(cockpit.configFolder, 'plugins');
  const marketplace = join(plugins, 'marketplaces', 'local');
  const plugin = join(marketplace, 'probe');
  mkdirSync(join(marketplace, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'commands'));
  writeFileSync(
    join(marketplace, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'local',
      owner: { name: 'the person' },
      plugins: [{ name: 'probe', source: './probe', description: 'Commands.' }],
    }),
  );
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'probe', version: '1.0.0', description: 'Commands.' }),
  );
  writeFileSync(join(plugin, 'commands', 'greet.md'), 'Say hello.');
  writeFileSync(
    join(plugins, 'known_marketplaces.json'),
    JSON.stringify({
      local: {
        source: { source: 'directory', path: marketplace },
        installLocation: marketplace,
        lastUpdated: INSTALLED_AT,
      },
    }),
  );
  writeFileSync(
    join(plugins, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'probe@local': [
          {
            scope: 'user',
            installPath: plugin,
            version: '1.0.0',
            installedAt: INSTALLED_AT,
            lastUpdated: INSTALLED_AT,
          },
        ],
      },
    }),
  );
  const hooks = join(plugin, 'hooks', 'hooks.json');
  const call = toolUse('Write', { file_path: hooks, content: planted(root, 'plugin') });
  cockpit.api.script(turn(call), turn('Done.'), turn('Again.'));

  await cockpit.say('plant the hook');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const results = toolResults(cockpit.api);
  await cockpit.exitByItself(SAID_KEY, cockpit.conversationOf(SAID_KEY));
  await cockpit.say('start again', 'again');
  await cockpit.sessionIn('again', 'idle');

  expect(results).toEqual([{ isError: true, text: expect.stringMatching(/denied/i) }]);
  expect(existsSync(hooks)).toBe(false);
  expect(readdirSync(root).filter((name) => name.startsWith('planted-'))).toEqual([]);
});

it("98 — In bypassPermissions, the driver's Edit denies on the agent's configuration file under every name hold: Write on the legacy .config.json and on a suffixed .claude-custom-oauth.json is refused, and no planted server runs at the next start; the same server written to .config.json by hand runs at the start after", async () => {
  const cockpit = await startContractCockpit({
    driver: {
      permissionMode: 'bypassPermissions',
      permissions: { allow: ['Read', 'Write', 'Edit'] },
    },
    personsSettings: BYPASS_ACCEPTED,
  });
  const { root, configFolder } = cockpit;
  // The agent's own configuration, the recipe kept, so the next start shows no dialog: a legacy
  // file that holds anything is read in place of .claude.json.
  const recipe = JSON.parse(readFileSync(join(configFolder, '.claude.json'), 'utf8'));
  const legacy = join(configFolder, '.config.json');
  const legacyContent = JSON.stringify({ ...recipe, mcpServers: plantedServers(root, 'legacy') });
  const suffixed = join(configFolder, '.claude-custom-oauth.json');
  const calls = [
    toolUse('Write', { file_path: legacy, content: legacyContent }),
    toolUse('Write', {
      file_path: suffixed,
      content: JSON.stringify({ ...recipe, mcpServers: plantedServers(root, 'suffixed') }),
    }),
  ];
  cockpit.api.script(
    ...calls.map((call) => turn(call)),
    turn('Done.'),
    turn('Again.'),
    turn('Once more.'),
  );

  await cockpit.say('plant the servers');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const results = toolResults(cockpit.api);
  // Killed: an agent that exits saves its own configuration on its way out.
  await cockpit.killAgent(SAID_KEY);
  await cockpit.say('start again', 'again');
  await cockpit.sessionIn('again', 'idle');
  const plantedAfterTheRefusal = readdirSync(root).filter((name) => name.startsWith('planted-'));
  await cockpit.killAgent('again');
  // What the refused Write would have written, written by the person: the file starts the server.
  writeFileSync(legacy, legacyContent);
  await cockpit.say('start once more', 'by-hand');
  await cockpit.sessionIn('by-hand', 'idle');

  expect(results).toHaveLength(calls.length);
  for (const refused of results) {
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/denied/i) });
  }
  expect(existsSync(suffixed)).toBe(false);
  expect(plantedAfterTheRefusal).toEqual([]);
  await eventually(() => expect(existsSync(join(root, 'planted-legacy'))).toBe(true));
});

/** An agent's or a skill's definition whose frontmatter holds a command hook that leaves a mark. */
function plantedDefinition(root: string, name: string): string {
  return [
    '---',
    `name: planted-${name}`,
    'description: Leaves a mark.',
    'hooks:',
    '  Stop:',
    '    - hooks:',
    '        - type: command',
    `          command: touch ${join(root, `planted-${name}`)}`,
    '---',
    'Leave a mark.',
    '',
  ].join('\n');
}

it("99 — In bypassPermissions, the driver's Edit denies on agents, skills and hooks' scripts hold: Write of an agent or a skill whose frontmatter holds hooks, in a project's .claude, the home's or the configuration folder, and of a script in a .claude/hooks folder, is refused", async () => {
  const cockpit = await startContractCockpit({
    driver: {
      permissionMode: 'bypassPermissions',
      permissions: { allow: ['Read', 'Write', 'Edit'] },
    },
    personsSettings: BYPASS_ACCEPTED,
  });
  const { root, configFolder, home, workFolder } = cockpit;
  const written = {
    'project-agent': join(workFolder, '.claude', 'agents', 'planted.md'),
    'project-skill': join(workFolder, '.claude', 'skills', 'planted', 'SKILL.md'),
    'home-agent': join(home, '.claude', 'agents', 'planted.md'),
    'persons-agent': join(configFolder, 'agents', 'planted.md'),
    'persons-skill': join(configFolder, 'skills', 'planted', 'SKILL.md'),
  };
  const script = join(workFolder, '.claude', 'hooks', 'start.sh');
  const calls = [
    ...Object.entries(written).map(([name, file_path]) =>
      toolUse('Write', { file_path, content: plantedDefinition(root, name) }),
    ),
    toolUse('Write', { file_path: script, content: `#!/bin/sh\ntouch ${root}/planted-script\n` }),
  ];
  cockpit.api.script(...calls.map((call) => turn(call)), turn('Done.'));

  await cockpit.say('plant the definitions');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const results = toolResults(cockpit.api);

  expect(results).toHaveLength(calls.length);
  for (const refused of results) {
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/denied/i) });
  }
  for (const file of [...Object.values(written), script]) {
    expect(existsSync(file), file).toBe(false);
  }
});
