import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const validatorPath = path.join(
  workspaceRoot,
  "scripts",
  "validate-production-config.mjs",
);
const dispatcherConfigPath = path.join(
  workspaceRoot,
  "apps",
  "docs-dispatcher",
  "wrangler.json",
);

test("enables Dynamic Workers for all production sites by default", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  assert.equal(config.vars.DOXA_PROD_DYNAMIC_RENDERER_MODE, "all");
  assert.equal(config.vars.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS, "");
  assert.equal(config.vars.DEBUG, "false");
  assert.equal(config.vars.DOXA_PROD_PRERENDER_MODE, "off");
  assert.equal(config.vars.DOXA_PROD_PRERENDER_SITE_IDS, "");
  assert.equal(config.vars.DOXA_PRERENDER_REPAIR_ENABLED, "false");
});

test("enables the lazy route-data cache for all production sites by default", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  assert.equal(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_MODE, "all");
  assert.equal(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS, "");
  assert.deepEqual(config.exports.DocsRouteDataCache, {
    type: "worker",
    cache: { enabled: true },
  });
});

test("rolls the shared renderer isolate out to the operator's canary sites", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  assert.equal(config.vars.DOXA_PROD_SHARED_ISOLATE_MODE, "allowlist");
  // The site IDs are an operator value, kept in the ops repo.
  assert.equal(
    config.vars.DOXA_PROD_SHARED_ISOLATE_SITE_IDS,
    "${OPS_DOCS_SHARED_ISOLATE_SITE_IDS}",
  );
});

test("shares docs cache entries across dispatcher versions", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  // Without this flag, every dispatcher deploy empties the docs cache.
  assert.deepEqual(config.cache, { enabled: false, cross_version_cache: true });
});

test("accepts an API production config with a custom-domain CNAME target", () => {
  const result = runValidator(createValidConfig());

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production configuration is valid/);
});

test("rejects an API production config without a custom-domain CNAME target", () => {
  const config = createValidConfig();
  config.env.production.vars = {};
  const result = runValidator(config);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOCS_CUSTOM_DOMAIN_CNAME_TARGET/);
});

test("rejects a production config without public global fetch routing", () => {
  const config = createValidConfig();
  config.env.production.compatibility_flags = ["nodejs_compat"];
  const result = runValidator(config);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /global_fetch_strictly_public/);
});

test("rejects a production config that drops Node.js compatibility", () => {
  const config = createValidConfig();
  config.env.production.compatibility_flags = ["global_fetch_strictly_public"];
  const result = runValidator(config);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /nodejs_compat/);
});

test("rejects an API production config without a fresh Hyperdrive binding", () => {
  const config = createValidConfig();
  config.env.production.hyperdrive = config.env.production.hyperdrive.filter(
    (binding) => binding.binding !== "HYPERDRIVE_CACHE_DISABLED",
  );
  const result = runValidator(config);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /HYPERDRIVE_CACHE_DISABLED/);
});

test("rejects Hyperdrive bindings that use the same configuration", () => {
  const config = createValidConfig();
  config.env.production.hyperdrive[1].id =
    config.env.production.hyperdrive[0].id;
  const result = runValidator(config);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /different configurations/);
});

function createValidConfig() {
  return {
    env: {
      production: {
        compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
        vars: {
          DOCS_CUSTOM_DOMAIN_CNAME_TARGET: "cname.doxa.page",
        },
        hyperdrive: [
          { binding: "HYPERDRIVE", id: "cached-hyperdrive-id" },
          {
            binding: "HYPERDRIVE_CACHE_DISABLED",
            id: "fresh-hyperdrive-id",
          },
        ],
      },
    },
  };
}

function runValidator(config) {
  const directory = mkdtempSync(path.join(tmpdir(), "doxa-production-config-"));
  const configPath = path.join(directory, "wrangler.json");

  try {
    writeFileSync(configPath, JSON.stringify(config));

    return spawnSync(
      process.execPath,
      [validatorPath, "--config", configPath],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
