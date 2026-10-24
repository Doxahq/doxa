import { validateMdxSource } from "./mdx-validator-core.mjs";

let source = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  source += chunk;
}

process.stdout.write(JSON.stringify(await validateMdxSource(source)));
