// The fake agent's entry: what a tmux session runs in place of Claude Code,
// with Claude Code's command line.
//
// The fake agent is TypeScript that Node runs as it is. This entry is plain
// JavaScript so that a Node too old for that says so, instead of failing on
// the first type it reads.
if (!process.features.typescript) {
  process.stderr.write(
    `The fake agent needs a Node that runs TypeScript (22.18 or later); this is ${process.version}.\n`,
  );
  process.exit(1);
}

await import('./main.ts');
