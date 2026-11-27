// Account-issued Cloudflare IDs (KV namespaces, Hyperdrive configs, zones,
// VPC Services) are not in this repo. Wrangler configs hold placeholders such
// as "${CF_AUTH_KV_ID}", and a deploy fills them from a values file that the
// operator keeps elsewhere. Names that we choose (Workers, buckets, queues,
// domains) stay in the configs. OPS_* placeholders carry other operator
// values that do not belong in a public repo, such as the admin emails.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PLACEHOLDER = /\$\{((?:CF|OPS)_[A-Z0-9_]+)\}/g;
const NAME = /^(?:CF|OPS)_[A-Z0-9_]+$/;
// No quote, backslash, space or "$": a value can never leave its JSON string.
const PLAIN_VALUE = /^[\w.:@,+-]+$/;

/**
 * Pathspecs that leave the Wrangler configs out of `git status`. A deploy
 * checkout fills their IDs, and that is not an uncommitted change: the API
 * image does not contain them, and the IDs come from the values file.
 */
export const EXCLUDE_WRANGLER_CONFIGS = [":(exclude)apps/*/wrangler*.json", ":(exclude)apps/**/wrangler*.json"];

/** The tracked Wrangler configs of the apps, relative to the repo root. */
export function wranglerConfigs(root) {
  const output = execFileSync("git", ["ls-files", "apps/*/wrangler*.json", "apps/**/wrangler*.json"], { cwd: root, encoding: "utf8" });
  return [...new Set(output.split("\n").filter(Boolean))];
}

/** Throws when a config still holds a placeholder: a deploy would send it to Cloudflare. */
export function assertIdsFilled(root) {
  const unfilled = wranglerConfigs(root)
    .map((file) => [file, placeholdersIn(readFileSync(path.join(root, file), "utf8"))])
    .filter(([, names]) => names.length > 0);
  if (unfilled.length > 0) {
    const list = unfilled.map(([file, names]) => `${file} (${names.join(", ")})`).join("; ");
    throw new Error(`The Wrangler configs still hold ID placeholders: ${list}. Fill them first with scripts/deploy/apply-production-ids.mjs --values <file>.`);
  }
}

/**
 * Throws when one config still holds a placeholder. Wrangler accepts a
 * placeholder in a variable as plain text, so it does not stop the deploy.
 */
export function assertConfigFilled(root, file) {
  const names = placeholdersIn(readFileSync(path.join(root, file), "utf8"));
  if (names.length > 0) {
    throw new Error(`${file} still holds placeholders: ${names.join(", ")}. Deploy it from the ops repo: scripts/deploy.sh main --step try-proxy.`);
  }
}

/** The placeholder names in a text, in order of first use. */
export function placeholdersIn(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

/**
 * The text with every placeholder replaced by its value. Throws when a
 * placeholder has no value, or when a value could break the JSON string it
 * lands in.
 */
export function fillPlaceholders(text, values, source = "the config") {
  const missing = placeholdersIn(text).filter((name) => !(name in values));
  if (missing.length > 0) throw new Error(`${source} needs values for: ${missing.join(", ")}.`);
  return text.replace(PLACEHOLDER, (_, name) => {
    const value = values[name];
    if (typeof value !== "string" || !PLAIN_VALUE.test(value)) {
      throw new Error(`The value of ${name} must be plain text (letters, digits and - _ . : @ , +).`);
    }
    return value;
  });
}

/** Checks a values file: an object of CF_* and OPS_* names to strings. */
export function parseValues(json, source = "the values file") {
  const values = JSON.parse(json);
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error(`${source} must hold one JSON object.`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (!NAME.test(name)) throw new Error(`${source}: "${name}" is not a CF_* or OPS_* name.`);
    if (typeof value !== "string") throw new Error(`${source}: ${name} must be a string.`);
  }
  return values;
}
