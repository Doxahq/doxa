// Bundles the job and its supervisor into two files with no dependencies.
// The final stage of the job image copies these two files and nothing else.
// Neutral conditions pick the plain ESM builds of the libraries, not their
// CommonJS Node builds; Node built-ins stay imports.
import { build } from "esbuild";

await build({
  entryPoints: { job: "src/job.ts", supervisor: "src/supervisor.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  external: ["node:*"],
  format: "esm",
  target: "node24",
  legalComments: "none",
  logLevel: "warning",
});
