#!/usr/bin/env node
/**
 * `pnpm --filter @doxahq/billing catalog:sync [--apply] [--live]` (spec 7.3).
 *
 * The command logic is `src/providers/stripe/sync/command.ts`. This file only
 * loads the TypeScript source: Node strips types but cannot resolve the
 * package's extensionless imports or its constructor parameter properties, so
 * a small resolve + load hook transpiles `.ts` with the package's own
 * `typescript`. No extra dependency.
 */
import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[cm]?[jt]s$/.test(specifier)) throw error;
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(`${specifier}/index.ts`, context);
      }
    }
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const { runCatalogSyncCommand } = await import("../src/providers/stripe/sync/command.ts");
process.exitCode = await runCatalogSyncCommand({
  argv: process.argv.slice(2),
  env: process.env,
  print: (line) => console.log(line),
});
