import { createInterface } from "node:readline";
import { validateMdxSource } from "./mdx-validator-core.mjs";

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of input) {
  if (!line.trim()) continue;

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    process.stderr.write(
      `Invalid MDX validator request: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    continue;
  }

  if (
    !request ||
    typeof request !== "object" ||
    typeof request.id !== "string" ||
    typeof request.source !== "string"
  ) {
    process.stderr.write("Invalid MDX validator request shape.\n");
    continue;
  }

  const result = await validateMdxSource(request.source);
  process.stdout.write(`${JSON.stringify({
    id: request.id,
    ...result,
  })}\n`);
}
