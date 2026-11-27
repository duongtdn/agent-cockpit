import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pinnedAgentVersion } from '../real-agent/binary.ts';
import {
  clearPartialPayloads,
  isRecording,
  mergePartialPayloads,
  RECORDED_PAYLOADS_FILE,
  type RecordedPayloads,
} from './payload-recording.ts';

/** The repository's formatter. */
const BIOME = new URL('../../../node_modules/.bin/biome', import.meta.url).pathname;

/**
 * Records the real agent's hook payloads over a run of the contract suite,
 * when `RECORD_HOOK_PAYLOADS=1`: each worker writes the shapes it saw to a
 * file of its own (it is a process of its own), and this setup, which runs
 * once in vitest's main process before the first file and after the last,
 * clears those files, then merges them into the recorded payloads. A
 * global setup rather than a reporter, so that it works whichever reporters
 * and files the run has.
 */
export default function setup(): (() => void) | undefined {
  if (!isRecording()) return undefined;
  clearPartialPayloads();
  return () => {
    const before = existsSync(RECORDED_PAYLOADS_FILE)
      ? (JSON.parse(readFileSync(RECORDED_PAYLOADS_FILE, 'utf8')) as RecordedPayloads)
      : undefined;
    const merged = mergePartialPayloads(pinnedAgentVersion(), before);
    mkdirSync(dirname(RECORDED_PAYLOADS_FILE), { recursive: true });
    writeFileSync(RECORDED_PAYLOADS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
    // Formatted as the repository's other files are, so that the lint passes on what was recorded.
    execFileSync(BIOME, ['format', '--write', RECORDED_PAYLOADS_FILE], { stdio: 'ignore' });
    clearPartialPayloads();
  };
}
