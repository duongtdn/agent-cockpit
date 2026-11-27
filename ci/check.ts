/**
 * `pnpm check:ci`: runs what `pnpm check` runs, then the contract suite a
 * second time, inside a container made like CI's runner (`ci/Dockerfile`),
 * once for each Node CI runs, side by side. Each run is held to fewer CPUs
 * than CI's runner gives and runs at a slowness factor above 1, so that a
 * race CI would meet is met here first.
 *
 * Options: `--node <major>` runs one Node only; `--rebuild` builds the image
 * again even when one of the same versions exists; `--command '<shell>'`
 * runs that in place of the checks, on the same machine (a row run again
 * and again, to see how often it fails). Environment:
 * `CHECK_CI_CPUS` (CPUs per run, 2 by default), `COCKPIT_TEST_SLOWNESS`
 * (2 by default).
 *
 * Each run's whole output is kept in `test-results/ci/node<major>/`, with
 * the run's own `test-results/` (the contract results, the timelines of
 * failed tests).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const REPOSITORY = join(import.meta.dirname, '..');
const NODE_MAJORS = [22, 24] as const;
/** CI's runner has 4: each run gets fewer, so that it is slower than CI, not faster. */
const DEFAULT_CPUS = 2;
const DEFAULT_SLOWNESS = '2';
const STORE_VOLUME = 'agent-cockpit-ci-pnpm-store';

/**
 * A network of the runs' own, with IPv6: CI's runner has an address of each
 * family beyond the loopback, which the tests of `--host ::` need, and
 * Docker's default network gives none of IPv6.
 */
const NETWORK = 'agent-cockpit-ci';
const NETWORK_SUBNET = 'fd7c:6b70:6974::/64';

/**
 * Docker's options for the agent's sandbox: bubblewrap makes user
 * namespaces, nested ones, and mounts a fresh `/proc`, which Docker's
 * default seccomp profile, its AppArmor profile and its masked `/proc`
 * paths may each refuse. The run checks the same nesting CI checks before
 * anything else, and fails there, saying so, if it still cannot.
 */
const SANDBOX_OPTIONS = [
  '--security-opt',
  'seccomp=unconfined',
  '--security-opt',
  'apparmor=unconfined',
  '--security-opt',
  'systempaths=unconfined',
];

/** What a run does inside its container, from a copy of the working tree. */
const IN_CONTAINER = `
set -eu
rsync -a --delete --exclude node_modules --exclude dist --exclude coverage --exclude test-results /repository/ "$HOME/work/"
cd "$HOME/work"
echo "== the agent's sandbox: user namespaces, nested ones too"
bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev unshare --user --map-root-user true
echo "== node $(node --version), $(tmux -V), $(nproc) CPUs, slowness $COCKPIT_TEST_SLOWNESS"
status=0
pnpm install --frozen-lockfile --store-dir "$HOME/.pnpm-store" || status=$?
if [ "$status" = 0 ] && [ -n "$CHECK_COMMAND" ]; then
  echo "== $CHECK_COMMAND"; bash -c "$CHECK_COMMAND" || status=$?
elif [ "$status" = 0 ]; then
  echo "== pnpm check"; pnpm check || status=$?
  if [ "$status" = 0 ]; then
    echo "== pnpm test:contract, a second time"; pnpm test:contract || status=$?
  fi
fi
cp -r test-results/. /results/ 2> /dev/null || true
exit "$status"
`;

interface Versions {
  readonly node: Readonly<Record<(typeof NODE_MAJORS)[number], string>>;
  readonly pnpm: string;
  readonly playwright: string;
}

interface Run {
  readonly major: number;
  readonly cpus: string;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The latest release of each Node CI runs, as `actions/setup-node` resolves a major. */
async function latestNodes(): Promise<Versions['node']> {
  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) throw new Error(`nodejs.org answered ${response.status}`);
  const releases = (await response.json()) as readonly { readonly version: string }[];
  const latest = (major: number) => {
    const release = releases.find(({ version }) => version.startsWith(`v${major}.`));
    if (release === undefined) throw new Error(`No release of Node ${major} on nodejs.org`);
    return release.version.slice(1);
  };
  return { 22: latest(22), 24: latest(24) };
}

async function versions(): Promise<Versions> {
  const manifest = JSON.parse(readFileSync(join(REPOSITORY, 'package.json'), 'utf8')) as {
    readonly packageManager: string;
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  const playwright = manifest.devDependencies.playwright;
  if (playwright === undefined) throw new Error('package.json names no playwright');
  return {
    node: await latestNodes(),
    pnpm: manifest.packageManager.replace(/^pnpm@/u, ''),
    playwright,
  };
}

function docker(args: readonly string[], quiet = false): number {
  const result = spawnSync('docker', args, { stdio: quiet ? 'ignore' : 'inherit' });
  return result.status ?? 1;
}

/** The image for these versions, built when none exists yet (or when asked). */
function image(of: Versions, rebuild: boolean): string {
  const dockerfile = readFileSync(join(REPOSITORY, 'ci', 'Dockerfile'), 'utf8');
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const buildArgs = {
    NODE_22: of.node[22],
    NODE_24: of.node[24],
    PNPM: of.pnpm,
    PLAYWRIGHT: of.playwright,
    UID: String(uid),
    GID: String(gid),
  };
  const digest = createHash('sha256')
    .update(dockerfile)
    .update(JSON.stringify(buildArgs))
    .digest('hex')
    .slice(0, 12);
  const tag = `agent-cockpit-ci:${digest}`;
  if (!rebuild && docker(['image', 'inspect', tag], true) === 0) return tag;
  console.log(`Building ${tag} (Node ${of.node[22]} and ${of.node[24]}, pnpm ${of.pnpm})`);
  const args = Object.entries(buildArgs).flatMap(([name, value]) => [
    '--build-arg',
    `${name}=${value}`,
  ]);
  if (docker(['build', '--tag', tag, ...args, join(REPOSITORY, 'ci')]) !== 0) {
    throw new Error('The image could not be built');
  }
  return tag;
}

/** The runs' network, made when missing. */
function network(): string {
  if (docker(['network', 'inspect', NETWORK], true) === 0) return NETWORK;
  if (docker(['network', 'create', '--ipv6', '--subnet', NETWORK_SUBNET, NETWORK], true) !== 0) {
    throw new Error(`The network ${NETWORK}, with IPv6, could not be made`);
  }
  return NETWORK;
}

/** Disjoint CPUs for each run, so that the two runs do not lend each other theirs. */
function plan(majors: readonly number[], cpusPerRun: number): Run[] {
  if (majors.length * cpusPerRun > availableParallelism()) {
    throw new Error(`${majors.length} runs of ${cpusPerRun} CPUs need more than this machine has`);
  }
  return majors.map((major, index) => {
    const first = index * cpusPerRun;
    return { major, cpus: `${first}-${first + cpusPerRun - 1}` };
  });
}

function containerName(run: Run): string {
  return `agent-cockpit-ci-${process.pid}-node${run.major}`;
}

/** Runs one Node's check in its container; resolves with its exit status. */
function runIn(
  tag: string,
  net: string,
  run: Run,
  slowness: string,
  command: string,
): Promise<number> {
  const results = join(REPOSITORY, 'test-results', 'ci', `node${run.major}`);
  rmSync(results, { recursive: true, force: true });
  mkdirSync(results, { recursive: true });
  const log = createWriteStream(join(results, 'output.log'));
  const prefix = `[node ${run.major}] `;
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--name',
      containerName(run),
      `--cpuset-cpus=${run.cpus}`,
      '--shm-size=2g',
      '--network',
      net,
      ...SANDBOX_OPTIONS,
      '--volume',
      `${REPOSITORY}:/repository:ro`,
      '--volume',
      `${results}:/results`,
      '--volume',
      `${STORE_VOLUME}:/home/runner/.pnpm-store`,
      '--env',
      'CI=true',
      '--env',
      `COCKPIT_TEST_SLOWNESS=${slowness}`,
      '--env',
      `CHECK_COMMAND=${command}`,
      '--env',
      `PATH=/opt/node${run.major}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      tag,
      'bash',
      '-c',
      IN_CONTAINER,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const started = Date.now();
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk: Buffer) => {
      log.write(chunk);
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }
  return new Promise((resolve) => {
    child.on('close', (code) => {
      const minutes = ((Date.now() - started) / 60_000).toFixed(1);
      log.end(`\n== exit ${code} after ${minutes} min\n`);
      console.log(`${prefix}${code === 0 ? 'green' : 'RED'} after ${minutes} min (${results})`);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const only = option('--node');
  const majors = only === undefined ? [...NODE_MAJORS] : [Number(only)];
  if (!majors.every((major) => (NODE_MAJORS as readonly number[]).includes(major))) {
    throw new Error(`--node takes one of ${NODE_MAJORS.join(', ')}`);
  }
  const cpusPerRun = Number(process.env.CHECK_CI_CPUS ?? DEFAULT_CPUS);
  const slowness = process.env.COCKPIT_TEST_SLOWNESS ?? DEFAULT_SLOWNESS;
  if (!(Number(slowness) > 1)) throw new Error('check:ci runs at a slowness factor above 1');
  const runs = plan(majors, cpusPerRun);
  const tag = image(await versions(), process.argv.includes('--rebuild'));
  const stop = () => {
    for (const run of runs) docker(['kill', containerName(run)], true);
    process.exit(130);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const net = network();
  const command = option('--command') ?? '';
  const statuses = await Promise.all(runs.map((run) => runIn(tag, net, run, slowness, command)));
  process.exitCode = statuses.every((status) => status === 0) ? 0 : 1;
}

await main();
