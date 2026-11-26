// A command hook for tests: posts the payload it reads to the address it is
// given, and prints the answer, as a hook that reports to a server would.
// Plain JavaScript: it runs as a command of its own, on any Node of the range.
let payload = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) payload += chunk;

const response = await fetch(process.argv[2], {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: payload,
});
process.stdout.write(await response.text());
