#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { requireResolverBinding } from "../../../scripts/lib/docs-placement-config.mjs";
import { preparePrerenderConfigs } from "./prepare-prerender-configs.mjs";

const SHARED_WORKER_NAME = "doxa-docs-renderer-shared";
const DISPATCHER_WORKER_NAME = "doxa-docs-renderer";
const DEFAULT_SHARED_CONFIG = "wrangler.renderer.shared.production.json";
const DEFAULT_SHARED_GENERATED_CONFIG = "dist/server/wrangler.json";
const DISPATCHER_BUCKET_BINDING = "RENDERER_CODE_BUCKET";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const templateRoot = path.resolve(scriptDirectory, "..");
const dispatcherRoot = path.resolve(templateRoot, "../docs-dispatcher");
const workspaceRoot = path.resolve(templateRoot, "../..");
const prerendererRoot = path.resolve(workspaceRoot, "apps/docs-prerenderer");

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

try {
  validateMode(options.mode, options.siteIds);
  validateMode(options.prerenderMode, options.prerenderSiteIds);
  validateMode(options.routeDataCacheMode, options.routeDataCacheSiteIds);
  validateBoolean(options.repairEnabled, "repair-enabled");
  const sharedConfigPath = path.resolve(templateRoot, options.sharedConfig);
  const sharedGeneratedConfigPath = path.resolve(
    templateRoot,
    options.sharedGeneratedConfig
  );
  assertFile(sharedConfigPath);
  validateSharedConfig(readJson(sharedConfigPath), sharedConfigPath);

  run("pnpm", ["run", "build:cloudflare"], {
    cwd: templateRoot,
    env: {
      ...process.env,
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: options.sharedConfig,
      DOXA_DEPLOY_TARGET: "cloudflare",
      // Minified server code without the local content source.
      DOXA_RENDERER_BUILD: "platform",
    },
  });

  assertFile(sharedGeneratedConfigPath);
  const sharedGeneratedConfig = readJson(sharedGeneratedConfigPath);
  validateSharedConfig(sharedGeneratedConfig, sharedGeneratedConfigPath);
  validateSharedRendererEntrypoint(
    sharedGeneratedConfig,
    sharedGeneratedConfigPath,
  );

  const packageArgs = [
    "scripts/package-renderer.mjs",
    "--app-root",
    dispatcherRoot,
    "--server-dir",
    "../docs-template/dist/server",
    "--mode",
    options.mode,
    "--prerender-mode",
    options.prerenderMode,
    "--repair-enabled",
    options.repairEnabled,
    "--route-data-cache-mode",
    options.routeDataCacheMode,
  ];
  if (options.siteIds) packageArgs.push("--site-ids", options.siteIds);
  if (options.prerenderSiteIds) {
    packageArgs.push("--prerender-site-ids", options.prerenderSiteIds);
  }
  if (options.routeDataCacheSiteIds) {
    packageArgs.push(
      "--route-data-cache-site-ids",
      options.routeDataCacheSiteIds
    );
  }
  run("node", packageArgs, { cwd: dispatcherRoot });

  const metadataPath = path.join(dispatcherRoot, "dist/renderer-package.json");
  const dispatcherConfigPath = path.join(
    dispatcherRoot,
    "dist/wrangler.production.json"
  );
  assertFile(metadataPath);
  assertFile(dispatcherConfigPath);
  const metadata = readJson(metadataPath);
  const dispatcherConfig = readJson(dispatcherConfigPath);
  validateDispatcherConfig(dispatcherConfig, dispatcherConfigPath, metadata);
  const preparedConfigs = await preparePrerenderConfigs({
    workspaceRoot,
    metadataPath: "apps/docs-dispatcher/dist/renderer-package.json",
    dispatcherConfigPath:
      "apps/docs-dispatcher/dist/wrangler.production.json",
    apiConfigPath: "apps/api/wrangler.json",
    apiOutputPath: "apps/api/dist/wrangler.production.json",
    prerendererConfigPath: "apps/docs-prerenderer/wrangler.json",
    prerendererOutputPath:
      "apps/docs-prerenderer/dist/wrangler.production.json",
  });

  if (options.dryRun) {
    globalThis.console.log(
      `[deploy-renderer] Dry run complete. Dynamic mode: ${options.mode}. Pre-render mode: ${options.prerenderMode}. Route-data cache mode: ${options.routeDataCacheMode}. Release: ${preparedConfigs.releaseId}.`
    );
    process.exit(0);
  }

  // Publish the fallback before moving the public route to the dispatcher.
  run("pnpm", ["exec", "wrangler", "deploy", "-c", sharedGeneratedConfigPath], {
    cwd: templateRoot,
  });

  const codeBucket = getCodeBucketName(dispatcherConfig);
  run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `${codeBucket}/${metadata.objectKey}`,
      "--file",
      metadata.packagePath,
      "--content-type",
      "application/json",
      "--content-encoding",
      "gzip",
      "--remote",
      "--force",
    ],
    { cwd: dispatcherRoot }
  );

  // This generated config carries the requested rollout mode and immutable
  // renderer build ID. Pass allowlist or off for a controlled rollback.
  run("pnpm", ["exec", "wrangler", "deploy", "-c", dispatcherConfigPath], {
    cwd: dispatcherRoot,
  });

  run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "-c",
      preparedConfigs.prerendererOutputPath,
    ],
    { cwd: prerendererRoot },
  );

  // The API: the Node origin on ECS with this renderer release, then the
  // thin doxa-api Worker. See scripts/deploy-api.mjs.
  run(
    process.execPath,
    ["scripts/deploy-api.mjs", "--renderer-release", preparedConfigs.releaseId],
    { cwd: workspaceRoot },
  );

  globalThis.console.log(
    `[deploy-renderer] Docs rendering deployment complete. Dynamic mode: ${options.mode}. Pre-render mode: ${options.prerenderMode}. Route-data cache mode: ${options.routeDataCacheMode}. Release: ${preparedConfigs.releaseId}.`
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function parseArgs(args) {
  const parsed = {
    sharedConfig: DEFAULT_SHARED_CONFIG,
    sharedGeneratedConfig: DEFAULT_SHARED_GENERATED_CONFIG,
    mode: process.env.DOXA_PROD_DYNAMIC_RENDERER_MODE?.trim() || "all",
    siteIds: process.env.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS?.trim() || "",
    prerenderMode:
      process.env.DOXA_PROD_PRERENDER_MODE?.trim() || "off",
    prerenderSiteIds:
      process.env.DOXA_PROD_PRERENDER_SITE_IDS?.trim() || "",
    repairEnabled:
      process.env.DOXA_PRERENDER_REPAIR_ENABLED?.trim() || "false",
    routeDataCacheMode:
      process.env.DOXA_PROD_ROUTE_DATA_CACHE_MODE?.trim() || "all",
    routeDataCacheSiteIds:
      process.env.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS?.trim() || "",
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--config") {
      parsed.sharedConfig = readArg(args, ++index, arg);
    } else if (arg === "--generated-config") {
      parsed.sharedGeneratedConfig = readArg(args, ++index, arg);
    } else if (arg === "--mode") {
      parsed.mode = readArg(args, ++index, arg);
    } else if (arg === "--site-ids") {
      parsed.siteIds = readArg(args, ++index, arg);
    } else if (arg === "--prerender-mode") {
      parsed.prerenderMode = readArg(args, ++index, arg);
    } else if (arg === "--prerender-site-ids") {
      parsed.prerenderSiteIds = readArg(args, ++index, arg);
    } else if (arg === "--repair-enabled") {
      parsed.repairEnabled = readArg(args, ++index, arg);
    } else if (arg === "--route-data-cache-mode") {
      parsed.routeDataCacheMode = readArg(args, ++index, arg);
    } else if (arg === "--route-data-cache-site-ids") {
      parsed.routeDataCacheSiteIds = readArg(args, ++index, arg);
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--skip-secret") {
      // Kept for compatibility. Shared rendering now uses a private RPC binding.
    } else if (arg === "--set-secret") {
      throw new Error(
        "--set-secret is no longer supported. The shared renderer does not use a content token."
      );
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function validateBoolean(value, label) {
  if (value === "true" || value === "false") return;
  throw new Error(
    `Invalid ${label} value ${JSON.stringify(value)}. Expected true or false.`,
  );
}

function validateMode(mode, siteIds) {
  if (mode !== "off" && mode !== "allowlist" && mode !== "all") {
    throw new Error(
      `Invalid dynamic renderer mode ${JSON.stringify(mode)}. Expected off, allowlist, or all.`
    );
  }
  if (mode === "allowlist" && !siteIds) {
    throw new Error("Allowlist mode requires at least one site ID.");
  }
}

function validateSharedConfig(config, configPath) {
  const label = path.relative(path.resolve(templateRoot, "../.."), configPath);
  if (config.name !== SHARED_WORKER_NAME) {
    throw new Error(
      `${label} must target ${SHARED_WORKER_NAME}, got ${JSON.stringify(config.name)}.`
    );
  }
  if (config.routes?.length) {
    throw new Error(`${label} must not own a public route.`);
  }
  if (config.vars?.DOXA_DOCS_RUNTIME_SOURCE !== "binding") {
    throw new Error(`${label} must use binding runtime mode.`);
  }
  const runtimeBinding = config.services?.find(
    (binding) => binding?.binding === "DOXA_DOCS_CONTENT_BINDING"
  );
  if (runtimeBinding?.entrypoint !== "RuntimeSourceApi") {
    throw new Error(
      `${label} must bind DOXA_DOCS_CONTENT_BINDING to RuntimeSourceApi.`
    );
  }
  if (!config.assets?.directory) {
    throw new Error(`${label} must include the client assets binding.`);
  }
}

function validateSharedRendererEntrypoint(config, configPath) {
  const mainModule = config.main;
  if (typeof mainModule !== "string" || !mainModule.trim()) {
    throw new Error(`${configPath} must define a main Worker module.`);
  }

  const mainModulePath = path.resolve(path.dirname(configPath), mainModule);
  assertFile(mainModulePath);
  const source = readFileSync(mainModulePath, "utf8");
  if (!source.includes("DocsPrerenderRenderer")) {
    throw new Error(
      `${mainModulePath} must export the DocsPrerenderRenderer RPC entrypoint.`,
    );
  }
}

function validateDispatcherConfig(config, configPath, metadata) {
  const label = path.relative(path.resolve(templateRoot, "../.."), configPath);
  requireResolverBinding(config, label);
  if (config.name !== DISPATCHER_WORKER_NAME) {
    throw new Error(`${label} must target ${DISPATCHER_WORKER_NAME}.`);
  }
  if (!config.worker_loaders?.some((item) => item?.binding === "LOADER")) {
    throw new Error(`${label} must define the LOADER worker binding.`);
  }
  for (const binding of [
    "DOCS_RESOLVER",
    "DOCS_RUNTIME",
    "SHARED_RENDERER",
    "PRERENDER_TASKS",
  ]) {
    if (!config.services?.some((item) => item?.binding === binding)) {
      throw new Error(`${label} is missing the ${binding} service binding.`);
    }
  }
  if (
    config.vars?.DOXA_RENDERER_BUILD_ID !== metadata.buildId ||
    config.vars?.DOXA_RENDERER_PACKAGE_KEY !== metadata.objectKey ||
    config.vars?.DOXA_RENDERER_RELEASE_ID !== metadata.rendererReleaseId
  ) {
    throw new Error(`${label} does not match the immutable renderer package.`);
  }
  if (config.vars?.DOXA_PROD_DYNAMIC_RENDERER_MODE !== options.mode) {
    throw new Error(`${label} does not match the requested rollout mode.`);
  }
  if (config.vars?.DOXA_PROD_PRERENDER_MODE !== options.prerenderMode) {
    throw new Error(`${label} does not match the pre-render rollout mode.`);
  }
  if (
    config.vars?.DOXA_PRERENDER_REPAIR_ENABLED !== options.repairEnabled
  ) {
    throw new Error(`${label} does not match the repair setting.`);
  }
  if (
    config.vars?.DOXA_PROD_ROUTE_DATA_CACHE_MODE !== options.routeDataCacheMode
  ) {
    throw new Error(`${label} does not match the route-data cache mode.`);
  }
  const ownsDocsRoute = config.routes?.some(
    (route) => route?.pattern === "*/*" && route?.zone_id
  );
  if (!ownsDocsRoute) {
    throw new Error(`${label} must own the zone-scoped */* route.`);
  }
  getCodeBucketName(config);
  const outputBucket = config.r2_buckets?.find(
    (item) => item?.binding === "DOCS_RENDERED_BUCKET",
  )?.bucket_name;
  if (typeof outputBucket !== "string" || !outputBucket.trim()) {
    throw new Error(`${label} must define DOCS_RENDERED_BUCKET.`);
  }
}

function getCodeBucketName(config) {
  const bucket = config.r2_buckets?.find(
    (item) => item?.binding === DISPATCHER_BUCKET_BINDING
  )?.bucket_name;
  if (typeof bucket !== "string" || !bucket.trim()) {
    throw new Error(
      `Dispatcher config must define ${DISPATCHER_BUCKET_BINDING}.`
    );
  }
  return bucket.trim();
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read JSON from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function assertFile(filePath) {
  if (!existsSync(filePath))
    throw new Error(`Missing required file: ${filePath}.`);
}

function readArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function run(command, args, options) {
  globalThis.console.log(`[deploy-renderer] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  globalThis.console.error(`[deploy-renderer] ${message}`);
  process.exitCode = 1;
}

function printHelp() {
  globalThis.console.log(`Build and deploy Doxa docs rendering.

Usage:
  pnpm deploy:renderer [options]

Options:
  --mode <off|allowlist|all>  Production Dynamic Worker rollout. Default: all
  --site-ids <id,id>          Production site IDs used by allowlist mode
  --prerender-mode <mode>     Saved-output rollout: off, allowlist, or all
  --prerender-site-ids <ids>  Site IDs used by pre-render allowlist mode
  --repair-enabled <boolean>  Enable or disable request-time repairs
  --route-data-cache-mode <mode>
                              Lazy route-data cache rollout: off, allowlist, or all.
                              Default: all
  --route-data-cache-site-ids <ids>
                              Site IDs used by route-data cache allowlist mode
  --config <path>             Shared renderer source config
  --generated-config <path>   Shared renderer generated config
  --dry-run                   Build, package, and validate without deploying
  --skip-secret               Deprecated no-op kept for command compatibility
  -h, --help                  Show this help

Environment alternatives:
  DOXA_PROD_DYNAMIC_RENDERER_MODE
  DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS
  DOXA_PROD_PRERENDER_MODE
  DOXA_PROD_PRERENDER_SITE_IDS
  DOXA_PRERENDER_REPAIR_ENABLED
  DOXA_PROD_ROUTE_DATA_CACHE_MODE
  DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS
`);
}
