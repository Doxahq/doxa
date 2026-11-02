#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { validateDocsPlacementConfigs } from "./lib/docs-placement-config.mjs";
import { validateDocsRuntimeConfig } from "./lib/docs-runtime-config.mjs";
import { validateMcpProductionConfig } from "./lib/mcp-production-config.mjs";
import {
  validatePrerenderRollout,
  validatePreviousFallbackVars,
} from "./lib/dispatcher-fallback-config.mjs";
import { validateWarmJobConfig } from "./lib/dispatcher-warm-config.mjs";

const DEFAULT_API_CONFIG = "apps/api/wrangler.json";
const DEFAULT_SHARED_RENDERER_CONFIG =
  "apps/docs-template/wrangler.renderer.shared.production.json";
const DEFAULT_DISPATCHER_CONFIG = "apps/docs-dispatcher/wrangler.json";
const DEFAULT_PRERENDERER_CONFIG = "apps/docs-prerenderer/wrangler.json";
const DEFAULT_RUNTIME_CONFIG = "apps/docs-runtime/wrangler.json";
const CNAME_TARGET_VAR = "DOCS_CUSTOM_DOMAIN_CNAME_TARGET";
const REQUIRED_PRODUCTION_COMPATIBILITY_FLAGS = [
  "nodejs_compat",
  "global_fetch_strictly_public",
];
const REQUIRED_HYPERDRIVE_BINDINGS = [
  "HYPERDRIVE",
  "HYPERDRIVE_CACHE_DISABLED",
];

/**
 * SEC-014: no production Worker answers on workers.dev or a preview URL.
 * Those hosts skip the zone WAF and rate rules, and the container Worker has
 * no caller check of its own. A key under env.production wins over the top
 * level, the same way Wrangler applies it.
 */
// The checked-in configs, also when a test runs this script from a copy.
const REPOSITORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const PRIVATE_URL_WORKER_CONFIGS = [
  "apps/agent-container/wrangler.json",
  "apps/agent-worker/wrangler.json",
  "apps/api-edge/wrangler.json",
  "apps/api/wrangler.json",
  "apps/api/wrangler.docs-resolver.json",
  "apps/docs-dispatcher/wrangler.json",
  "apps/docs-prerenderer/wrangler.json",
  "apps/docs-runtime/wrangler.json",
  "apps/docs-template/wrangler.renderer.shared.production.json",
  "apps/email-worker/wrangler.json",
  "apps/mcp/wrangler.json",
  "apps/web/wrangler.json",
];

try {
  const requestedConfigPath = readConfigPath(process.argv.slice(2));
  const configPath = path.resolve(process.cwd(), requestedConfigPath);
  const config = readJson(configPath);
  const cnameTarget = config?.env?.production?.vars?.[CNAME_TARGET_VAR];

  if (typeof cnameTarget !== "string" || cnameTarget.trim().length === 0) {
    throw new Error(
      `${path.relative(process.cwd(), configPath)} must define env.production.vars.${CNAME_TARGET_VAR}.`,
    );
  }

  validateProductionCompatibilityFlags(config, configPath);
  validateHyperdriveBindings(config, configPath);
  if (process.argv.length === 2) {
    validateDocsRenderingConfigs();
    validateDocsRuntimeConfig(readJson(DEFAULT_RUNTIME_CONFIG));
    validateDocsPlacementConfigs({
      api: config,
      resolver: readJson("apps/api/wrangler.docs-resolver.json"),
      dispatcher: readJson(DEFAULT_DISPATCHER_CONFIG),
      runtime: readJson("apps/docs-runtime/wrangler.json"),
      shared: readJson(DEFAULT_SHARED_RENDERER_CONFIG),
      web: readJson("apps/web/wrangler.json"),
    });
    validateMcpProductionConfig({ mcp: readJson("apps/mcp/wrangler.json"), api: config });
    validateNoPublicWorkerUrls(PRIVATE_URL_WORKER_CONFIGS);
  }

  globalThis.console.log(
    "[production-config] Production configuration is valid.",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  globalThis.console.error(`[production-config] ${message}`);
  process.exitCode = 1;
}

function validateDocsRenderingConfigs() {
  const sharedPath = path.resolve(
    process.cwd(),
    DEFAULT_SHARED_RENDERER_CONFIG,
  );
  const dispatcherPath = path.resolve(process.cwd(), DEFAULT_DISPATCHER_CONFIG);
  const shared = readJson(sharedPath);
  const dispatcher = readJson(dispatcherPath);
  const prerenderer = readJson(DEFAULT_PRERENDERER_CONFIG);
  const api = readJson(DEFAULT_API_CONFIG);

  if (shared.name !== "doxa-docs-renderer-shared") {
    throw new Error(
      `${DEFAULT_SHARED_RENDERER_CONFIG} has the wrong Worker name.`,
    );
  }
  if (shared.routes?.length) {
    throw new Error(
      `${DEFAULT_SHARED_RENDERER_CONFIG} must not own public routes.`,
    );
  }
  if (shared.vars?.DOXA_DOCS_RUNTIME_SOURCE !== "binding") {
    throw new Error(
      `${DEFAULT_SHARED_RENDERER_CONFIG} must use binding runtime mode.`,
    );
  }
  requireServiceBinding(
    shared,
    "DOXA_DOCS_CONTENT_BINDING",
    DEFAULT_SHARED_RENDERER_CONFIG,
  );

  if (dispatcher.name !== "doxa-docs-renderer") {
    throw new Error(`${DEFAULT_DISPATCHER_CONFIG} has the wrong Worker name.`);
  }
  if (dispatcher.vars?.DOXA_PROD_DYNAMIC_RENDERER_MODE !== "all") {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must default dynamic rendering to all.`,
    );
  }
  validatePrerenderRollout(dispatcher.vars, DEFAULT_DISPATCHER_CONFIG);
  validatePreviousFallbackVars(dispatcher.vars, DEFAULT_DISPATCHER_CONFIG);
  validateWarmJobConfig(dispatcher, DEFAULT_DISPATCHER_CONFIG);
  if (dispatcher.vars?.DOXA_PROD_ROUTE_DATA_CACHE_MODE !== "all") {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must default the route-data cache to all.`,
    );
  }
  // The shared renderer isolate rolls out per site. A typo would silently keep
  // every site on its own isolate, so only the three modes are accepted.
  if (
    !["off", "allowlist", "all"].includes(
      dispatcher.vars?.DOXA_PROD_SHARED_ISOLATE_MODE,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must set DOXA_PROD_SHARED_ISOLATE_MODE to off, allowlist or all.`,
    );
  }
  // A typo would silently turn the route-data prefetch off.
  if (
    !["off", "allowlist", "all"].includes(
      dispatcher.vars?.DOXA_PROD_ROUTE_DATA_PREFETCH_MODE,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must set DOXA_PROD_ROUTE_DATA_PREFETCH_MODE to off, allowlist or all.`,
    );
  }
  // The hostname map rolls out off → shadow → on. A typo fails closed to off
  // at runtime, so only the three modes are accepted here.
  if (
    !["off", "shadow", "on"].includes(
      dispatcher.vars?.DOXA_PROD_KV_HOSTNAME_MODE,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must set DOXA_PROD_KV_HOSTNAME_MODE to off, shadow or on.`,
    );
  }
  // HTTP → HTTPS and HSTS. A typo fails closed to off at runtime.
  if (!["off", "on"].includes(dispatcher.vars?.DOXA_PROD_HTTPS_REDIRECT_MODE)) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must set DOXA_PROD_HTTPS_REDIRECT_MODE to off or on.`,
    );
  }
  // Route data in the browser cache rolls out per site.
  if (
    !["off", "allowlist", "all"].includes(
      dispatcher.vars?.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must set DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE to off, allowlist or all.`,
    );
  }
  if (
    typeof dispatcher.vars?.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS !==
    "string"
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must define DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS.`,
    );
  }
  // Text routes and old client assets roll out from off. A typo fails closed
  // to off at runtime, so only the documented modes are accepted here.
  if (
    !["off", "allowlist", "all"].includes(
      dispatcher.vars?.DOXA_PROD_TEXT_ROUTE_CACHE_MODE,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must set DOXA_PROD_TEXT_ROUTE_CACHE_MODE to off, allowlist or all.`,
    );
  }
  if (
    !["off", "on"].includes(
      dispatcher.vars?.DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must set DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE to off or on.`,
    );
  }
  if (
    !dispatcher.kv_namespaces?.some(
      (item) => item?.binding === "DOCS_HOSTNAME_MAP" && item?.id,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must define the DOCS_HOSTNAME_MAP KV namespace.`,
    );
  }
  if (dispatcher.vars?.DOXA_PRERENDER_REPAIR_ENABLED !== "false") {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must default request repairs to false.`,
    );
  }
  if (!dispatcher.worker_loaders?.some((item) => item?.binding === "LOADER")) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must define the LOADER binding.`,
    );
  }
  for (const binding of [
    "DOCS_RESOLVER",
    "DOCS_RUNTIME",
    "SHARED_RENDERER",
    "PRERENDER_TASKS",
  ]) {
    requireServiceBinding(dispatcher, binding, DEFAULT_DISPATCHER_CONFIG);
  }
  if (
    !dispatcher.r2_buckets?.some(
      (item) => item?.binding === "RENDERER_CODE_BUCKET" && item?.bucket_name,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must define RENDERER_CODE_BUCKET.`,
    );
  }
  requireR2Binding(
    dispatcher,
    "DOCS_RENDERED_BUCKET",
    DEFAULT_DISPATCHER_CONFIG,
  );
  if (
    dispatcher.exports?.DocsPrerenderCache?.cache?.enabled !== true
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must cache DocsPrerenderCache internally.`,
    );
  }
  if (dispatcher.cache?.cross_version_cache !== true) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must share cache entries across Worker versions (cache.cross_version_cache).`,
    );
  }
  if (dispatcher.exports?.DocsRouteDataCache?.cache?.enabled !== true) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must cache DocsRouteDataCache internally.`,
    );
  }
  // Without it, every new dispatcher isolate reads the renderer code from R2.
  if (dispatcher.exports?.DocsRendererCodeCache?.cache?.enabled !== true) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must cache DocsRendererCodeCache internally.`,
    );
  }
  // Without them, the text routes and old client assets reach R2 or the
  // renderer on every request.
  for (const entrypoint of ["DocsTextCache", "DocsClientAssetCache"]) {
    if (dispatcher.exports?.[entrypoint]?.cache?.enabled !== true) {
      throw new Error(
        `${DEFAULT_DISPATCHER_CONFIG} must cache ${entrypoint} internally.`,
      );
    }
  }
  if (dispatcher.assets?.html_handling !== "none") {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must disable implicit HTML asset routing.`,
    );
  }
  if (
    !dispatcher.routes?.some(
      (route) => route?.pattern === "*/*" && route?.zone_id,
    )
  ) {
    throw new Error(
      `${DEFAULT_DISPATCHER_CONFIG} must own the zone-scoped */* route.`,
    );
  }

  if (
    prerenderer.name !== "doxa-docs-prerenderer-production" ||
    prerenderer.workers_dev !== false ||
    prerenderer.preview_urls !== false ||
    prerenderer.routes?.length
  ) {
    throw new Error(
      `${DEFAULT_PRERENDERER_CONFIG} must define a private Worker.`,
    );
  }
  requireServiceBinding(
    prerenderer,
    "PRERENDER_RENDERER",
    DEFAULT_PRERENDERER_CONFIG,
  );
  requireServiceBinding(
    prerenderer,
    "PRERENDER_TASKS",
    DEFAULT_PRERENDERER_CONFIG,
  );
  requireR2Binding(
    prerenderer,
    "DOCS_RENDERED_BUCKET",
    DEFAULT_PRERENDERER_CONFIG,
  );
  if (
    !prerenderer.workflows?.some(
      (workflow) =>
        workflow?.binding === "PRERENDER_WORKFLOW" &&
        workflow?.class_name === "DocsPrerenderWorkflow",
    )
  ) {
    throw new Error(
      `${DEFAULT_PRERENDERER_CONFIG} must define PRERENDER_WORKFLOW.`,
    );
  }
  requireServiceBinding(
    api.env?.production,
    "PRERENDER_QUEUE",
    DEFAULT_API_CONFIG,
  );
}

function validateNoPublicWorkerUrls(configPaths) {
  for (const configPath of configPaths) {
    const config = readJson(path.join(REPOSITORY_ROOT, configPath));
    for (const scope of [config, config.env?.production].filter(Boolean)) {
      const workersDev = scope.workers_dev ?? config.workers_dev;
      const previewUrls = scope.preview_urls ?? config.preview_urls;
      if (workersDev !== false || previewUrls !== false) {
        throw new Error(
          `${configPath} must set workers_dev and preview_urls to false.`,
        );
      }
    }
  }
}

function requireServiceBinding(config, binding, configPath) {
  if (!config.services?.some((item) => item?.binding === binding)) {
    throw new Error(
      `${configPath} must define the ${binding} service binding.`,
    );
  }
}

function requireR2Binding(config, binding, configPath) {
  if (
    !config.r2_buckets?.some(
      (item) => item?.binding === binding && item?.bucket_name,
    )
  ) {
    throw new Error(`${configPath} must define ${binding}.`);
  }
}

function readConfigPath(args) {
  if (args.length === 0) return DEFAULT_API_CONFIG;
  if (args.length === 2 && args[0] === "--config" && args[1]) return args[1];

  throw new Error("Usage: validate-production-config.mjs [--config <path>]");
}

function readJson(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${configPath}: ${message}`);
  }
}

function validateProductionCompatibilityFlags(config, configPath) {
  const relativeConfigPath = path.relative(process.cwd(), configPath);
  const compatibilityFlags = config?.env?.production?.compatibility_flags;

  for (const flag of REQUIRED_PRODUCTION_COMPATIBILITY_FLAGS) {
    if (
      !Array.isArray(compatibilityFlags) ||
      !compatibilityFlags.includes(flag)
    ) {
      throw new Error(
        `${relativeConfigPath} must define env.production.compatibility_flags with ${flag}.`,
      );
    }
  }
}

function validateHyperdriveBindings(config, configPath) {
  const relativeConfigPath = path.relative(process.cwd(), configPath);
  const hyperdriveBindings = config?.env?.production?.hyperdrive;
  if (!Array.isArray(hyperdriveBindings)) {
    throw new Error(
      `${relativeConfigPath} must define env.production.hyperdrive.`,
    );
  }

  const bindingIds = new Map();
  for (const bindingName of REQUIRED_HYPERDRIVE_BINDINGS) {
    const binding = hyperdriveBindings.find(
      (candidate) => candidate?.binding === bindingName,
    );
    if (typeof binding?.id !== "string" || binding.id.trim().length === 0) {
      throw new Error(
        `${relativeConfigPath} must define the ${bindingName} Hyperdrive binding.`,
      );
    }
    bindingIds.set(bindingName, binding.id);
  }

  if (new Set(bindingIds.values()).size !== bindingIds.size) {
    throw new Error(
      `${relativeConfigPath} must use different configurations for cached and fresh Hyperdrive bindings.`,
    );
  }
}
