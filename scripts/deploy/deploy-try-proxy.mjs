#!/usr/bin/env node
// Deploys doxa-try-proxy. The kill switch and the blocklist depend on this
// deploy, so it stops if the config still holds a placeholder. Wrangler accepts
// a placeholder in a variable as plain text, and that value blocks nothing.
//
// To load the values of the ops repo, run this from doxa-ops:
//   scripts/deploy.sh main --step try-proxy

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { assertConfigFilled } from "./lib/production-ids.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

try {
  assertConfigFilled(ROOT, "apps/try-proxy/wrangler.json");
} catch (error) {
  console.error(`[deploy:try-proxy] ${error.message}`);
  process.exit(1);
}

const result = spawnSync("pnpm", ["--filter", "@doxahq/try-proxy", "exec", "wrangler", "deploy"], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
