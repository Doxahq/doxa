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
    RuntimeSourceApi: { type: "worker", cache: { enabled: false } },
    DocsBlobCache: { type: "worker", cache: { enabled: true } },
  });
  assert.doesNotThrow(() => validateDocsRuntimeConfig(config));
});

test("rolls the blob cache out only when an operator turns it on", () => {
  const config = runtimeConfig();

  assert.equal(config.env.production.vars.DOXA_PROD_BLOB_CACHE_MODE, "off");
  assert.equal(config.env.production.vars.DOXA_PROD_BLOB_CACHE_SITE_IDS, "");
});

test("rejects a cached default or RPC entrypoint", () => {
  for (const entrypoint of ["default", "RuntimeSourceApi"]) {
    const config = runtimeConfig();
    config.exports[entrypoint].cache.enabled = true;

    assert.throws(
      () => validateDocsRuntimeConfig(config),
      new RegExp(`must not cache the ${entrypoint} entrypoint`),
    );
  }
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
