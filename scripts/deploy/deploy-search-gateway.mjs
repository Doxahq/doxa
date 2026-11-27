#!/usr/bin/env node
// Deploys doxa-search-gateway. The first deploy also creates the custom domain
// lexis.doxa.so. It stops if the config still holds a placeholder.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { assertConfigFilled } from "./lib/production-ids.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

try {
  assertConfigFilled(ROOT, "apps/search-gateway/wrangler.json");
} catch (error) {
  console.error(`[deploy:search-gateway] ${error.message}`);
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  ["--filter", "@doxahq/search-gateway", "exec", "wrangler", "deploy"],
  { cwd: ROOT, stdio: "inherit" },
);
process.exit(result.status ?? 1);
