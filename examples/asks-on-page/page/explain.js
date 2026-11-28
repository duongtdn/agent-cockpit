// What the page tells the person of a `CockpitError`: its code, then what
// it means for them.

/**
 * Says what an error means, by its code, the code first (`terminal-only: …`)
 * so that a person can look it up in the API's reference.
 *
 * @param error - What a call of the client threw, or the error its streams reported.
 * @returns The words to show.
 */
export function explain(error) {
  return error.code === undefined ? error.message : `${error.code}: ${meaningOf(error)}`;
}

function meaningOf(error) {
  switch (error.code) {
    case 'no-token':
      return 'this page has no valid token: open the link the server printed.';
    case 'refused':
      return `the cockpit refused this page (${error.cause}).`;
    case 'unreachable':
      return 'the server cannot be reached; following again as soon as it can.';
    case 'invalid-arguments':
      return error.issues.map((issue) => issue.message).join(' ');
    case 'wrong-state':
      return `${error.key} is ${error.state}: answer what it waits for first.`;
    case 'unknown-id':
      return 'the cockpit knows no ask of that id: its unit of work was removed, or the server restarted.';
    case 'already-settled':
      return `it was settled already, by ${error.by}.`;
    case 'terminal-only':
      return 'only a person in the session’s terminal can answer it.';
    case 'invalid-answer':
      return error.issues.map((issue) => issue.message).join(' ');
    default:
      return error.message;
  }
}
