import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS } from '../support/hooks/payload-recording.ts';
import { recordedPayload, recordedPayloads, SAMPLE_VALUES } from '../support/recorded-hooks.ts';

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { devDependencies: Record<string, string> };

describe("the real agent's recorded hook payloads", () => {
  it('are of the pinned agent: moving the pin records them again', () => {
    expect(recordedPayloads().version).toBe(manifest.devDependencies['@anthropic-ai/claude-code']);
  });

  it('fill a session’s values into the placeholders', () => {
    const values = {
      sessionId: 'c0ffee00-0000-4000-8000-000000000001',
      transcriptPath: '/r/config/projects/-r-work/c0ffee00-0000-4000-8000-000000000001.jsonl',
      cwd: '/r/work',
      root: '/r',
    };

    expect(recordedPayload('SessionStart', { source: 'startup' }, values)).toMatchObject({
      hook_event_name: 'SessionStart',
      session_id: values.sessionId,
      transcript_path: values.transcriptPath,
      cwd: values.cwd,
    });
    const placeholders = Object.values(PLACEHOLDERS);
    const filled = JSON.stringify(recordedPayload('SubagentStop', {}, SAMPLE_VALUES));
    expect(placeholders.filter((placeholder) => filled.includes(placeholder))).toEqual([]);
  });

  it('give a copy, the test’s to change', () => {
    const payload = recordedPayload('Stop');
    payload.last_assistant_message = 'Changed.';

    expect(recordedPayload('Stop').last_assistant_message).not.toBe('Changed.');
  });

  it('choose a shape by its fields or by a test, and refuse one never recorded', () => {
    expect(recordedPayload('SessionEnd', { reason: 'other' }).reason).toBe('other');
    expect(recordedPayload('StopFailure', (payload) => 'agent_id' in payload)).toHaveProperty(
      'agent_id',
    );
    expect(() => recordedPayload('SessionEnd', { reason: 'logout' })).toThrow(
      /No recorded SessionEnd payload fits \{"reason":"logout"\}; recorded shapes: .*reason=other/,
    );
    expect(() => recordedPayload('NoSuchEvent')).toThrow('recorded shapes: none');
  });
});
