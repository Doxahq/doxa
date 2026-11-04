import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertConfigFilled, assertIdsFilled, fillPlaceholders, parseValues, placeholdersIn } from "./lib/production-ids.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

test("refuses to deploy one config that still holds a placeholder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "doxa-ids-"));
  try {
    writeFileSync(path.join(root, "wrangler.json"), '{"DOXA_TRY_BLOCKED_HOSTS":"${OPS_TRY_BLOCKED_HOSTS}"}');
    assert.throws(() => assertConfigFilled(root, "wrangler.json"), /OPS_TRY_BLOCKED_HOSTS/);
    writeFileSync(path.join(root, "wrangler.json"), '{"DOXA_TRY_BLOCKED_HOSTS":"api.example.com"}');
    assert.doesNotThrow(() => assertConfigFilled(root, "wrangler.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds each placeholder once", () => {
  assert.deepEqual(placeholdersIn('{"a":"${CF_X}","b":"${CF_Y}","c":"${CF_X}","d":"${NOT_CF}"}'), ["CF_X", "CF_Y"]);
});

test("fills every placeholder, and refuses a missing value", () => {
  assert.equal(fillPlaceholders('{"id":"${CF_KV_ID}"}', { CF_KV_ID: "0123abcd" }), '{"id":"0123abcd"}');
  assert.throws(() => fillPlaceholders('{"id":"${CF_KV_ID}"}', {}, "apps/x/wrangler.json"), /apps\/x\/wrangler.json needs values for: CF_KV_ID/);
});

test("refuses a value that could break out of its JSON string", () => {
  for (const value of ['abc"', "a b", "x\\n", "", "${CF_OTHER}"]) {
    assert.throws(() => fillPlaceholders('{"id":"${CF_KV_ID}"}', { CF_KV_ID: value }), /must be plain text/, value);
  }
});

test("fills operator values such as an email list", () => {
  const filled = fillPlaceholders('{"ADMIN_EMAILS":"${OPS_ADMIN_EMAILS}"}', { OPS_ADMIN_EMAILS: "a@example.com,b+ops@example.com" });
  assert.deepEqual(JSON.parse(filled), { ADMIN_EMAILS: "a@example.com,b+ops@example.com" });
});

test("fills the pre-render canary site list of the docs dispatcher", () => {
  const config = readFileSync(path.join(ROOT, "apps/docs-dispatcher/wrangler.json"), "utf8");
  assert.ok(placeholdersIn(config).includes("OPS_DOCS_PRERENDER_SITE_IDS"));
  const siteIds = "cd881737-04c0-4500-a1b5-180a696a4cc8,ef0a576b-88eb-498b-99f0-7099671342d8";
  const filled = fillPlaceholders('{"DOXA_PROD_PRERENDER_SITE_IDS":"${OPS_DOCS_PRERENDER_SITE_IDS}"}', {
    OPS_DOCS_PRERENDER_SITE_IDS: siteIds,
  });
  assert.equal(JSON.parse(filled).DOXA_PROD_PRERENDER_SITE_IDS, siteIds);
});

test("checks the shape of a values file", () => {
  assert.deepEqual(parseValues('{"CF_KV_ID":"abc"}'), { CF_KV_ID: "abc" });
  assert.throws(() => parseValues("[]"), /one JSON object/);
  assert.throws(() => parseValues('{"KV_ID":"abc"}'), /not a CF_\* or OPS_\* name/);
  assert.throws(() => parseValues('{"CF_KV_ID":1}'), /must be a string/);
});

// The public configs must never hold an account-issued ID again: each one
// is a placeholder, so this repo can be public. Names we choose may stay.
test("no Wrangler config holds a personal email address", () => {
  const files = execFileSync("git", ["ls-files", "apps/**/wrangler*.json", "apps/*/wrangler*.json"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  // Product addresses (no-reply@mail.doxa.so) are fine; a personal mailbox is not.
  const personal = /[\w.+-]+@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)\.[a-z.]+/i;
  const offenders = files.filter((file) => personal.test(readFileSync(path.join(ROOT, file), "utf8")));
  assert.deepEqual(offenders, []);
});

test("no Wrangler config holds a KV, Hyperdrive, VPC Service or zone ID", () => {
  const files = execFileSync("git", ["ls-files", "apps/**/wrangler*.json", "apps/*/wrangler*.json"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const offenders = [];
  for (const file of files) {
    const walk = (value, at) => {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`));
      else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`);
      else if (/\.(id|zone_id|service_id|account_id|CLOUDFLARE_ZONE_ID|CLOUDFLARE_ACCOUNT_ID)$/.test(at) && typeof value === "string") {
        const allowed = /^\$\{CF_[A-Z0-9_]+\}$/.test(value) || /^local-/.test(value);
        if (!allowed) offenders.push(`${file}${at}=${value}`);
      }
    };
    walk(JSON.parse(readFileSync(path.join(ROOT, file), "utf8")), "");
  }
  assert.deepEqual(offenders, []);
});

test("a deploy refuses this checkout until the ops values fill the placeholders", () => {
  assert.throws(() => assertIdsFilled(ROOT), /still hold ID placeholders: .*apps\/api-edge\/wrangler.json \(CF_API_ORIGIN_VPC_SERVICE_ID\)/);
});
