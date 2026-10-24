#!/usr/bin/env node
// Fills the Cloudflare ID placeholders ("${CF_*}") of every Wrangler config
// in this checkout from a values file, before a production deploy. The
// operator's ops repo keeps the values file. See docs/current/self-hosting.md.
//
//   node scripts/apply-production-ids.mjs --values <file>          fill in place
//   node scripts/apply-production-ids.mjs --values <file> --check  only check that every placeholder has a value
//   node scripts/apply-production-ids.mjs --list                   list the placeholders
//
// It changes files in place, so run it in a deploy checkout, not in your
// working tree.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fillPlaceholders, parseValues, placeholdersIn, wranglerConfigs } from "./lib/production-ids.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const options = parseArgs(process.argv.slice(2));

const configs = wranglerConfigs(ROOT);

if (options.list) {
  for (const file of configs) {
    const names = placeholdersIn(readFileSync(path.join(ROOT, file), "utf8"));
    if (names.length > 0) console.log(`${file}: ${names.join(", ")}`);
  }
  process.exit(0);
}

const values = attempt(() => parseValues(readFileSync(options.values, "utf8"), options.values));
const used = new Set();
let changed = 0;
for (const file of configs) {
  const fullPath = path.join(ROOT, file);
  const text = readFileSync(fullPath, "utf8");
  const names = placeholdersIn(text);
  if (names.length === 0) continue;
  names.forEach((name) => used.add(name));
  const filled = attempt(() => fillPlaceholders(text, values, file));
  attempt(() => JSON.parse(filled));
  if (!options.check) {
    writeFileSync(fullPath, filled);
    changed++;
  }
}

const unused = Object.keys(values).filter((name) => !used.has(name));
if (unused.length > 0) console.warn(`[production-ids] Not used by any config: ${unused.join(", ")}.`);
console.log(options.check ? `[production-ids] Every placeholder has a value (${used.size}).` : `[production-ids] Filled ${used.size} IDs in ${changed} configs.`);

function parseArgs(args) {
  const parsed = { values: undefined, check: false, list: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") parsed.check = true;
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--values") {
      parsed.values = args[++i];
      if (!parsed.values) fail("--values needs a file.");
    } else fail(`Unknown argument "${arg}".`);
  }
  if (!parsed.list && !parsed.values) fail("Pass --values <file>, or --list.");
  return parsed;
}

function attempt(check) {
  try {
    return check();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(message) {
  console.error(`[production-ids] ${message}`);
  process.exit(1);
}
