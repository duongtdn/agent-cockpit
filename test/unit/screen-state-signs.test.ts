import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';

/**
 * The agent's screen is a sign of its state (idle or busy) in a few listed
 * places only, where nothing else tells it; everywhere else the core reads
 * the screen for where to type and what waits for a person. These tests
 * keep the two apart in the code, so that a new reading of the state from
 * the screen cannot slip in unnoticed: it changes the list, here.
 */

const SOURCE = fileURLToPath(new URL('../../src', import.meta.url));

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** The core's files (the driver's boundary, where the readings are declared, left out) that hold the text. */
function coreFilesWith(pattern: RegExp): string[] {
  return sourceFiles(join(SOURCE, 'server'))
    .filter((path) => !path.endsWith('driver.ts'))
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SOURCE, path))
    .sort();
}

describe("the screen's signs of the agent's state", () => {
  it("are the whole list: a launch panel's close", () => {
    expect(Object.keys(claudeCode().screenStateSigns)).toEqual(['launchPanelClosed']);
  });

  it('are read in one place of the core: the watch of a launch prompt that opened a panel', () => {
    expect(coreFilesWith(/launchPanelClosed/)).toEqual(['server/sessions/launch-prompt-watch.ts']);
    expect(coreFilesWith(/screenStateSigns/)).toEqual(['server/sessions/sessions.ts']);
  });

  it('are not the reading of the input box, which only tells where to type: the start, and a first prompt typed after it', () => {
    expect(coreFilesWith(/'input-box'/)).toEqual([
      'server/sessions/input-box-wait.ts',
      'server/sessions/start-up-watch.ts',
    ]);
  });
});
