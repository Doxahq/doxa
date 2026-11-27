import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  validatePrerenderRollout,
  validatePreviousFallbackVars,
} from "../lib/dispatcher-fallback-config.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const validatorPath = path.join(
  workspaceRoot,
  "scripts",
  "deploy",
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
  assert.equal(config.vars.DOXA_PRERENDER_REPAIR_ENABLED, "false");
});

test("serves pre-rendered pages (M36) for every site", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  // Set allowlist (with the ops site IDs) or off to narrow or revert.
  assert.equal(config.vars.DOXA_PROD_PRERENDER_MODE, "all");
  // Ignored in `all` mode, kept so a switch back to `allowlist` needs no new value.
  assert.equal(
    config.vars.DOXA_PROD_PRERENDER_SITE_IDS,
    "${OPS_DOCS_PRERENDER_SITE_IDS}",
  );
});

test("keeps the previous-build fallback off and warms every public site", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  assert.equal(config.vars.DOXA_PROD_PREVIOUS_FALLBACK_MODE, "off");
  assert.equal(config.vars.DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS, "86400");
  assert.equal(config.vars.DOXA_PROD_WARM_MODE, "all");
  // Ignored in `all` mode, kept so a switch back to `allowlist` needs no new value.
  assert.equal(config.vars.DOXA_PROD_WARM_SITE_IDS, "${OPS_DOCS_WARM_SITE_IDS}");
  // The renderer deploy writes these from the release record.
  assert.equal(config.vars.DOXA_PREVIOUS_RENDERER_BUILD_ID, "");
  assert.equal(config.vars.DOXA_PREVIOUS_RENDERER_RELEASE_ID, "");
  assert.equal(config.vars.DOXA_RENDERER_DEPLOYED_AT, "");
});

test("validates the committed docs configs of this checkout", () => {
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("accepts every pre-render rollout mode and rejects a typo", () => {
  const vars = {
    DOXA_PROD_PRERENDER_MODE: "allowlist",
    DOXA_PROD_PRERENDER_SITE_IDS: "site-1",
  };
  for (const mode of ["off", "allowlist", "all"]) {
    validatePrerenderRollout({ ...vars, DOXA_PROD_PRERENDER_MODE: mode }, "x");
  }
  assert.throws(
    () => validatePrerenderRollout({ ...vars, DOXA_PROD_PRERENDER_MODE: "on" }, "x"),
    /off, allowlist or all/,
  );
  assert.throws(
    () => validatePrerenderRollout({ ...vars, DOXA_PROD_PRERENDER_SITE_IDS: "" }, "x"),
    /must list DOXA_PROD_PRERENDER_SITE_IDS/,
  );
});

test("checks the previous-build fallback flags", () => {
  const vars = {
    DOXA_PROD_PREVIOUS_FALLBACK_MODE: "off",
    DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS: "86400",
    DOXA_PROD_WARM_MODE: "off",
    DOXA_PROD_WARM_SITE_IDS: "",
    DOXA_PREVIOUS_RENDERER_BUILD_ID: "",
    DOXA_PREVIOUS_RENDERER_RELEASE_ID: "",
    DOXA_RENDERER_DEPLOYED_AT: "",
  };
  validatePreviousFallbackVars(vars, "x");
  validatePreviousFallbackVars(
    { ...vars, DOXA_PROD_PREVIOUS_FALLBACK_MODE: "shadow", DOXA_PROD_WARM_MODE: "allowlist" },
    "x",
  );
  for (const [change, message] of [
    [{ DOXA_PROD_PREVIOUS_FALLBACK_MODE: "all" }, /off, shadow or on/],
    [{ DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS: "1d" }, /whole seconds/],
    [{ DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS: "0" }, /whole seconds/],
    [{ DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS: "999999" }, /whole seconds/],
    [{ DOXA_PROD_WARM_MODE: "on" }, /DOXA_PROD_WARM_MODE/],
    [{ DOXA_PROD_WARM_SITE_IDS: undefined }, /DOXA_PROD_WARM_SITE_IDS/],
    [{ DOXA_PREVIOUS_RENDERER_BUILD_ID: "a".repeat(64) }, /must leave DOXA_PREVIOUS_RENDERER_BUILD_ID empty/],
    [{ DOXA_RENDERER_DEPLOYED_AT: "2026-10-29T00:00:00Z" }, /must leave DOXA_RENDERER_DEPLOYED_AT empty/],
  ]) {
    assert.throws(() => validatePreviousFallbackVars({ ...vars, ...change }, "x"), message);
  }
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

test("shares one renderer isolate per build for every site (M46)", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  // Set allowlist (with the ops site IDs) or off to narrow or revert.
  assert.equal(config.vars.DOXA_PROD_SHARED_ISOLATE_MODE, "all");
  // Ignored in `all` mode, kept so a switch back to `allowlist` needs no new value.
  assert.equal(
    config.vars.DOXA_PROD_SHARED_ISOLATE_SITE_IDS,
    "${OPS_DOCS_SHARED_ISOLATE_SITE_IDS}",
  );
});

test("caches the renderer code package in Workers Cache", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  assert.deepEqual(config.exports.DocsRendererCodeCache, {
    type: "worker",
    cache: { enabled: true },
  });
});

test("caches text routes for every site and serves old client assets", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  // Set off to revert either one.
  assert.equal(config.vars.DOXA_PROD_TEXT_ROUTE_CACHE_MODE, "all");
  assert.equal(config.vars.DOXA_PROD_TEXT_ROUTE_CACHE_SITE_IDS, "");
  assert.equal(config.vars.DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE, "on");
  assert.deepEqual(config.exports.DocsTextCache, {
    type: "worker",
    cache: { enabled: true },
  });
  assert.deepEqual(config.exports.DocsClientAssetCache, {
    type: "worker",
    cache: { enabled: true },
  });
});

test("prefetches route data on cold renderer starts for every site", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  // Set the mode to off to revert; the renderer needs no change.
  assert.equal(config.vars.DOXA_PROD_ROUTE_DATA_PREFETCH_MODE, "all");
  assert.equal(config.vars.DOXA_PROD_ROUTE_DATA_PREFETCH_SITE_IDS, "");
});

test("serves hostnames from the KV map", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  // On reads KV first and falls back to the hostname cache on a miss.
  // Set shadow to serve the old path again while KV still logs agreement.
  assert.equal(config.vars.DOXA_PROD_KV_HOSTNAME_MODE, "on");
  // The namespace ID is account-issued, so the ops repo holds it.
  assert.deepEqual(config.kv_namespaces, [
    { binding: "DOCS_HOSTNAME_MAP", id: "${CF_DOCS_HOSTNAME_MAP_KV_ID}" },
  ]);
});

test("redirects HTTP to HTTPS and lets browsers cache route data", () => {
  const config = JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));

  // Set off to revert either one.
  assert.equal(config.vars.DOXA_PROD_HTTPS_REDIRECT_MODE, "on");
  assert.equal(config.vars.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE, "all");
  assert.equal(config.vars.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS, "");
});

test("accepts the committed docs rendering configs", () => {
  const result = runRepositoryValidator();

  assert.equal(result.status, 0, result.stderr);
});

test("accepts every valid HTTPS redirect and browser-cache mode", () => {
  for (const [name, value] of [
    ["DOXA_PROD_HTTPS_REDIRECT_MODE", "on"],
    ["DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE", "allowlist"],
    ["DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE", "all"],
  ]) {
    const result = runRepositoryValidator((dispatcher) => {
      dispatcher.vars[name] = value;
    });
    assert.equal(result.status, 0, `${name}=${value}: ${result.stderr}`);
  }
});

test("rejects an invalid HTTPS redirect mode", () => {
  const result = runRepositoryValidator((dispatcher) => {
    dispatcher.vars.DOXA_PROD_HTTPS_REDIRECT_MODE = "true";
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOXA_PROD_HTTPS_REDIRECT_MODE/);
});

test("rejects an invalid route-data browser-cache mode", () => {
  const result = runRepositoryValidator((dispatcher) => {
    dispatcher.vars.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE = "on";
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE/);
});

test("rejects a dispatcher config without the browser-cache site list", () => {
  const result = runRepositoryValidator((dispatcher) => {
    delete dispatcher.vars.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS;
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS/);
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

/** Every config that the validator reads without `--config`. */
const REPOSITORY_CONFIGS = [
  "apps/api/wrangler.json",
  "apps/api/wrangler.docs-resolver.json",
  "apps/docs-dispatcher/wrangler.json",
  "apps/docs-prerenderer/wrangler.json",
  "apps/docs-runtime/wrangler.json",
  "apps/docs-template/wrangler.renderer.shared.production.json",
  "apps/mcp/wrangler.json",
  "apps/web/wrangler.json",
];

/**
 * Runs the full validator on a copy of the repository configs. `change`
 * edits the copied dispatcher config first.
 */
function runRepositoryValidator(change = () => undefined) {
  const directory = mkdtempSync(path.join(tmpdir(), "doxa-repository-config-"));

  try {
    for (const relativePath of REPOSITORY_CONFIGS) {
      const config = JSON.parse(
        readFileSync(path.join(workspaceRoot, relativePath), "utf8"),
      );
      if (relativePath === "apps/docs-dispatcher/wrangler.json") change(config);
      const target = path.join(directory, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(config));
    }

    return spawnSync(process.execPath, [validatorPath], {
      cwd: directory,
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
