import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateDocsRuntimeConfig } from "./lib/docs-runtime-config.mjs";

const runtimeConfigPath = path.resolve(
  import.meta.dirname,
  "..",
  "apps",
  "docs-runtime",
  "wrangler.json",
);

function runtimeConfig() {
  return JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
}

test("caches only the DocsBlobCache entrypoint of the docs runtime", () => {
  const config = runtimeConfig();

  assert.deepEqual(config.cache, { enabled: false, cross_version_cache: true });
  assert.deepEqual(config.exports, {
    default: { type: "worker", cache: { enabled: false } },
    DocsBlobCache: { type: "worker", cache: { enabled: true } },
  });
  assert.doesNotThrow(() => validateDocsRuntimeConfig(config));
});

test("rolls the blob cache out to the operator's canary sites", () => {
  const config = runtimeConfig();

  // Canary sites only. The site IDs are an operator value in the ops repo.
  assert.equal(
    config.env.production.vars.DOXA_PROD_BLOB_CACHE_MODE,
    "allowlist",
  );
  assert.equal(
    config.env.production.vars.DOXA_PROD_BLOB_CACHE_SITE_IDS,
    "${OPS_DOCS_BLOB_CACHE_SITE_IDS}",
  );
});

test("rejects a cached default entrypoint", () => {
  const config = runtimeConfig();
  config.exports.default.cache.enabled = true;

  assert.throws(
    () => validateDocsRuntimeConfig(config),
    /must not cache the default entrypoint/,
  );
});

test("rejects cache options for the RPC-only RuntimeSourceApi", () => {
  const config = runtimeConfig();
  config.exports.RuntimeSourceApi = { type: "worker", cache: { enabled: false } };

  assert.throws(
    () => validateDocsRuntimeConfig(config),
    /must not list the RPC-only RuntimeSourceApi/,
  );
});

test("rejects a runtime whose Worker cache is on by default", () => {
  const config = runtimeConfig();
  config.cache.enabled = true;

  assert.throws(() => validateDocsRuntimeConfig(config), /cache off/);
});

test("rejects a DocsBlobCache without the Worker cache", () => {
  const config = runtimeConfig();
  delete config.exports.DocsBlobCache;

  assert.throws(() => validateDocsRuntimeConfig(config), /DocsBlobCache/);
});

test("rejects cache settings in the production environment", () => {
  const config = runtimeConfig();
  config.env.production.exports = config.exports;

  assert.throws(() => validateDocsRuntimeConfig(config), /top level/);
});

test("rejects an unknown blob cache mode", () => {
  const config = runtimeConfig();
  config.env.production.vars.DOXA_PROD_BLOB_CACHE_MODE = "on";

  assert.throws(
    () => validateDocsRuntimeConfig(config),
    /DOXA_PROD_BLOB_CACHE_MODE/,
  );
});
