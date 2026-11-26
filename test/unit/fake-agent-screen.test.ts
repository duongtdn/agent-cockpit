import { describe, expect, it } from 'vitest';
import { renderScreen } from '../support/fake-agent/screen.ts';

const view = {
  sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
  permissionMode: 'default',
  state: 'idle',
  step: undefined,
  dialog: undefined,
  lastPrompt: undefined,
  problem: undefined,
  input: '',
} as const;

describe("the fake agent's screen", () => {
  it('shows the session, its mode, its state and an empty input box', () => {
    expect(renderScreen(view)).toEqual([
      'fake agent',
      'session: 6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
      'mode: default',
      'state: idle',
      'dialog: none',
      'prompt: none',
      '> ',
    ]);
  });

  it('shows the last prompt on one line, whatever it holds', () => {
    const lines = renderScreen({ ...view, state: 'busy', lastPrompt: 'one\ntwo' });

    expect(lines).toContain('state: busy');
    expect(lines).toContain('prompt: "one\\ntwo"');
  });

  it('shows the step a running turn plays, between its state and its dialog', () => {
    const lines = renderScreen({ ...view, state: 'busy', step: 'stay-busy' });

    expect(lines.slice(3, 6)).toEqual(['state: busy', 'step: stay-busy', 'dialog: none']);
  });

  it('shows the dialog a person could answer (behavior 9)', () => {
    const lines = renderScreen({
      ...view,
      state: 'waiting',
      dialog: { kind: 'permission', toolName: 'Bash' },
    });

    expect(lines).toContain('dialog: permission Bash');
  });

  it('shows what is in the input box, line by line', () => {
    expect(renderScreen({ ...view, input: 'one\ntwo' }).slice(-2)).toEqual(['> one', '  two']);
  });

  it('shows a problem with the script', () => {
    expect(renderScreen({ ...view, problem: 'turn 1 has no step' })).toContain(
      'problem: turn 1 has no step',
    );
  });
});
