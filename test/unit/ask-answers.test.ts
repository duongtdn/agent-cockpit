import { describe, expect, it } from 'vitest';
import { checkAnswer } from '../../src/server/asks/answers.ts';

/** The issues of an answer to a permission, none when it fits. */
function issuesOf(answer: unknown) {
  const checked = checkAnswer('permission', answer);
  return 'issues' in checked ? checked.issues : [];
}

/** The paths of an answer's issues. */
function pathsOf(answer: unknown) {
  return issuesOf(answer).map((issue) => issue.path);
}

describe("a permission's answer", () => {
  it.each([
    { allow: true },
    { allow: true, remember: 'session' },
    { allow: false },
    { allow: false, message: 'Use the test runner instead.' },
    { allow: false, message: 'x'.repeat(100_000) },
  ])('takes %j as it is', (answer) => {
    expect(checkAnswer('permission', answer)).toEqual({ answer });
  });

  it.each([null, 'allow', true, 1, ['allow']])('is refused when it is no object: %j', (answer) => {
    expect(pathsOf(answer)).toEqual([[]]);
  });

  it.each([{}, { allow: 'yes' }, { allow: 1 }, { allow: null }, { remember: 'session' }])(
    'is refused when allow is missing or no boolean: %j',
    (answer) => {
      expect(pathsOf(answer)).toEqual([['allow']]);
    },
  );

  it.each(['always', true, null])('is refused when remember is %j, not session', (remember) => {
    expect(pathsOf({ allow: true, remember })).toEqual([['remember']]);
  });

  it('is refused at remember when it remembers a denial', () => {
    expect(pathsOf({ allow: false, remember: 'session' })).toEqual([['remember']]);
  });

  it('is refused at message when an allow carries a message', () => {
    expect(pathsOf({ allow: true, message: 'Go on.' })).toEqual([['message']]);
  });

  it.each([
    [{ allow: true, remember: undefined }, { allow: true }],
    [{ allow: false, message: undefined }, { allow: false }],
    [{ allow: true, message: undefined }, { allow: true }],
    [{ allow: false, remember: undefined }, { allow: false }],
  ])('takes a field given as undefined as absent, and leaves it out: %j', (answer, taken) => {
    const checked = checkAnswer('permission', answer);
    expect(checked).toEqual({ answer: taken });
    expect(Object.keys('answer' in checked ? checked.answer : {})).toEqual(['allow']);
  });

  it.each([
    ['no string', 42],
    ['empty', ''],
    ['over 100,000 characters', 'x'.repeat(100_001)],
  ])("is refused when a denial's message is %s", (_case, message) => {
    expect(pathsOf({ allow: false, message })).toEqual([['message']]);
  });

  it.each([
    { allow: true, approve: true },
    { allow: false, answers: { q: 'a' } },
    { allow: true, mode: 'auto' },
  ])('is refused when it has another field, as another kind of answer does: %j', (answer) => {
    const issues = issuesOf(answer);
    expect(issues).toHaveLength(1);
    const [field] = Object.keys(answer).filter((name) => name !== 'allow');
    expect(issues[0]?.message).toContain(field);
  });

  it('gives each issue a path and a message', () => {
    for (const issue of issuesOf({ allow: false, message: '' })) {
      expect(issue).toEqual({ path: expect.any(Array), message: expect.any(String) });
    }
  });
});
