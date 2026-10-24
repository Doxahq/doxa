// Returns the input text as the job output.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(JSON.stringify({ ok: true, output: Buffer.concat(chunks).toString("utf8") }));
