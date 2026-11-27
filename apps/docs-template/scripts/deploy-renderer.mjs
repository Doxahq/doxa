#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  listClientAssetFiles,
  planClientAssetUploads,
  runQuietCommand,
  uploadClientAssets,
} from "../../../scripts/deploy/lib/client-assets-upload.mjs";
import { requireResolverBinding } from "../../../scripts/deploy/lib/docs-placement-config.mjs";
import {
  RENDERER_RELEASE_RECORD_KEY,
  createRendererReleaseRecord,
  describeReleaseRecordWriteFailure,
  findPreviousBuildVarsProblem,
  isMissingObjectOutput,
  parsePreviousFallbackOption,
  parseRendererReleaseRecord,
  parseRevokedReleaseId,
  previousBuildVars,
  releaseRecordPutArgs,
  retryReleaseRecordWrite,
} from "../../../scripts/deploy/lib/renderer-release-record.mjs";
import {
  describeQueueProblems,
  findQueueProblems,
} from "../../../scripts/deploy/lib/warm-queue-preflight.mjs";
import { cloudflareApiFromEnvironment } from "../../../scripts/deploy/lib/release/cloudflare-api.mjs";
import {
  requireStagedManifest,
  withRendererRecord,
  writeManifestFile,
} from "../../../scripts/deploy/lib/release/manifest.mjs";
import { stageService } from "../../../scripts/deploy/lib/release/stage.mjs";
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
  // F10: fail before any build when the operator did not choose.
  const previousFallback = parsePreviousFallbackOption(options.previousFallback);
  const revoke = options.revoke.map(parseRevokedReleaseId);
  // A stage adds to the release that the release step started: fail before the build.
  if (options.stage) requireStagedManifest(workspaceRoot);
  validateMode(options.mode, options.siteIds);
  // Unset keeps the committed rollout (F1); package-renderer reads it.
  if (options.prerenderMode !== undefined) {
    validateMode(options.prerenderMode, options.prerenderSiteIds);
  }
  validateMode(options.routeDataCacheMode, options.routeDataCacheSiteIds);
  validateBoolean(options.repairEnabled, "repair-enabled");
  const sourceDispatcherConfig = readJson(
    path.join(dispatcherRoot, "wrangler.json"),
  );
  // F2: a missing queue fails the dispatcher deploy after the shared
  // renderer went live. Check before any build or upload.
  if (options.dryRun) {
    globalThis.console.log(
      "[deploy-renderer] Dry run: the warm queues are not checked.",
    );
  } else {
    assertQueuesExist(sourceDispatcherConfig);
  }
  // Read before packaging: the package plans the previous build from it.
  const releaseRecord = options.dryRun
    ? null
    : readReleaseRecord(getCodeBucketName(sourceDispatcherConfig));
  if (options.dryRun) {
    globalThis.console.log(
      "[deploy-renderer] Dry run: the release record is not read; the previous build stays empty.",
    );
  }
  const releaseRecordPath = path.join(
    dispatcherRoot,
    "dist/release-record.read.json",
  );
  if (releaseRecord) {
    mkdirSync(path.dirname(releaseRecordPath), { recursive: true });
    writeFileSync(releaseRecordPath, `${JSON.stringify(releaseRecord)}\n`);
  }
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
    "--repair-enabled",
    options.repairEnabled,
    "--route-data-cache-mode",
    options.routeDataCacheMode,
    "--previous-fallback",
    previousFallback,
  ];
  if (releaseRecord) packageArgs.push("--release-record", releaseRecordPath);
  for (const releaseId of revoke) packageArgs.push("--revoke", releaseId);
  if (options.siteIds) packageArgs.push("--site-ids", options.siteIds);
  if (options.prerenderMode) {
    packageArgs.push("--prerender-mode", options.prerenderMode);
  }
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
  validateDispatcherConfig(
    dispatcherConfig,
    dispatcherConfigPath,
    metadata,
    sourceDispatcherConfig,
  );
  globalThis.console.log(
    `[deploy-renderer] Previous build: ${metadata.previousBuild.previous?.buildId ?? "none"} (${metadata.previousBuild.reason}).`,
  );
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
      `[deploy-renderer] Dry run complete. Dynamic mode: ${options.mode}. Pre-render mode: ${dispatcherConfig.vars.DOXA_PROD_PRERENDER_MODE}. Route-data cache mode: ${options.routeDataCacheMode}. Release: ${preparedConfigs.releaseId}.`
    );
    process.exit(0);
  }

  const codeBucket = getCodeBucketName(dispatcherConfig);
  // Pages from earlier deploys still load their old hashed client files. Put
  // this build's files next to the older ones before any Worker serves it.
  await uploadBuildClientAssets(codeBucket);

  if (options.stage) {
    await stageRendererWorkers({
      codeBucket,
      metadata,
      releaseRecord,
      revoke,
      sharedGeneratedConfigPath,
      dispatcherConfigPath,
      prerendererConfigPath: preparedConfigs.prerendererOutputPath,
    });
    globalThis.console.log(
      `[deploy-renderer] Docs rendering staged. Dynamic mode: ${options.mode}. Pre-render mode: ${dispatcherConfig.vars.DOXA_PROD_PRERENDER_MODE}. Route-data cache mode: ${options.routeDataCacheMode}. Release: ${preparedConfigs.releaseId}. The flip serves it.`
    );
    process.exit(0);
  }

  // Publish the fallback before moving the public route to the dispatcher.
  run("pnpm", ["exec", "wrangler", "deploy", "-c", sharedGeneratedConfigPath], {
    cwd: templateRoot,
  });

  putRendererPackage(codeBucket, metadata);

  // This generated config carries the requested rollout mode and immutable
  // renderer build ID. Pass allowlist or off for a controlled rollback.
  run("pnpm", ["exec", "wrangler", "deploy", "-c", dispatcherConfigPath], {
    cwd: dispatcherRoot,
  });

  // The dispatcher now serves this build, so the record names it (F10).
  // A failed write does not stop the prerenderer and API deploys (they must
  // match the live dispatcher); the deploy still exits non-zero at the end.
  const recordWritten = await writeReleaseRecord(
    codeBucket,
    createRendererReleaseRecord({
      record: releaseRecord,
      current: {
        buildId: metadata.buildId,
        releaseId: metadata.rendererReleaseId,
        packageKey: metadata.objectKey,
      },
      plan: metadata.previousBuild,
      revoke,
    }),
  );

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
  // thin doxa-api Worker. See scripts/deploy/deploy-api.mjs.
  run(
    process.execPath,
    ["scripts/deploy/deploy-api.mjs", "--renderer-release", preparedConfigs.releaseId],
    { cwd: workspaceRoot },
  );

  globalThis.console.log(
    `[deploy-renderer] Docs rendering deployment complete. Dynamic mode: ${options.mode}. Pre-render mode: ${dispatcherConfig.vars.DOXA_PROD_PRERENDER_MODE}. Route-data cache mode: ${options.routeDataCacheMode}. Release: ${preparedConfigs.releaseId}.`
  );
  if (!recordWritten) {
    fail(
      `The release record was not written. Run the command printed above before the next renderer deploy.`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function uploadBuildClientAssets(bucket) {
  const assetsDirectory = path.join(templateRoot, "dist/client/assets");
  const uploads = planClientAssetUploads({
    assetsDirectory,
    files: await listClientAssetFiles(assetsDirectory),
  });
  const count = await uploadClientAssets({
    uploads,
    bucket,
    run: (args, upload) =>
      runQuietCommand("pnpm", args, {
        cwd: dispatcherRoot,
        label: "deploy-renderer",
        description: `client asset ${upload.key}`,
      }),
  });
  globalThis.console.log(
    `[deploy-renderer] Uploaded ${count} client assets to ${bucket}.`,
  );
}

/**
 * Release step (--stage): uploads the three Workers as versions without
 * traffic, and leaves the release record to the flip, which writes it once
 * the dispatcher serves this build. The flip serves the shared renderer
 * before the dispatcher (scripts/deploy/lib/release/services.mjs).
 */
async function stageRendererWorkers({
  codeBucket,
  metadata,
  releaseRecord,
  revoke,
  sharedGeneratedConfigPath,
  dispatcherConfigPath,
  prerendererConfigPath,
}) {
  const cloudflare = cloudflareApiFromEnvironment(workspaceRoot);
  const targetOf = (appRoot, configPath) => ({
    cwd: path.relative(workspaceRoot, appRoot),
    args: ["-c", path.relative(appRoot, configPath)],
  });

  await stageService(workspaceRoot, {
    id: "docs-renderer-shared",
    target: targetOf(templateRoot, sharedGeneratedConfigPath),
    cloudflare,
  });
  // The package key is immutable, so the live dispatcher never reads it.
  putRendererPackage(codeBucket, metadata);
  await stageService(workspaceRoot, {
    id: "docs-dispatcher",
    target: targetOf(dispatcherRoot, dispatcherConfigPath),
    cloudflare,
  });
  await stageService(workspaceRoot, {
    id: "docs-prerenderer",
    target: targetOf(prerendererRoot, prerendererConfigPath),
    cloudflare,
  });

  writeManifestFile(
    workspaceRoot,
    withRendererRecord(requireStagedManifest(workspaceRoot), {
      bucket: codeBucket,
      recordBefore: releaseRecord,
      recordAfter: createRendererReleaseRecord({
        record: releaseRecord,
        current: {
          buildId: metadata.buildId,
          releaseId: metadata.rendererReleaseId,
          packageKey: metadata.objectKey,
        },
        plan: metadata.previousBuild,
        revoke,
      }),
    }),
  );
}

function putRendererPackage(bucket, metadata) {
  run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${metadata.objectKey}`,
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
}

function parseArgs(args) {
  const parsed = {
    sharedConfig: DEFAULT_SHARED_CONFIG,
    sharedGeneratedConfig: DEFAULT_SHARED_GENERATED_CONFIG,
    mode: process.env.DOXA_PROD_DYNAMIC_RENDERER_MODE?.trim() || "all",
    siteIds: process.env.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS?.trim() || "",
    // Unset keeps the committed rollout of the dispatcher config (F1).
    prerenderMode: process.env.DOXA_PROD_PRERENDER_MODE?.trim() || undefined,
    prerenderSiteIds:
      process.env.DOXA_PROD_PRERENDER_SITE_IDS?.trim() || undefined,
    repairEnabled:
      process.env.DOXA_PRERENDER_REPAIR_ENABLED?.trim() || "false",
    routeDataCacheMode:
      process.env.DOXA_PROD_ROUTE_DATA_CACHE_MODE?.trim() || "all",
    routeDataCacheSiteIds:
      process.env.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS?.trim() || "",
    previousFallback:
      process.env.DOXA_RENDERER_PREVIOUS_FALLBACK?.trim() || undefined,
    revoke: [],
    dryRun: false,
    stage: false,
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
    } else if (arg === "--previous-fallback") {
      parsed.previousFallback = readArg(args, ++index, arg);
    } else if (arg === "--revoke") {
      parsed.revoke.push(readArg(args, ++index, arg));
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--stage") {
      parsed.stage = true;
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

function validateDispatcherConfig(config, configPath, metadata, sourceConfig) {
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
  const prerenderMode =
    options.prerenderMode ?? sourceConfig.vars?.DOXA_PROD_PRERENDER_MODE;
  if (config.vars?.DOXA_PROD_PRERENDER_MODE !== prerenderMode) {
    throw new Error(`${label} does not match the pre-render rollout mode.`);
  }
  validateMode(
    config.vars.DOXA_PROD_PRERENDER_MODE,
    config.vars.DOXA_PROD_PRERENDER_SITE_IDS,
  );
  // F24: deploy.sh --step docs-rendering skips the raw-config validation, so
  // the previous-build vars are checked here, on the generated config.
  const previousProblem = findPreviousBuildVarsProblem(config.vars);
  if (previousProblem) throw new Error(`${label}: ${previousProblem}.`);
  const expectedPrevious = previousBuildVars(metadata.previousBuild);
  for (const [name, value] of Object.entries(expectedPrevious)) {
    if (config.vars[name] !== value) {
      throw new Error(`${label} does not match the planned ${name}.`);
    }
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

/** Read-only: `wrangler queues info` for every queue the dispatcher binds. */
function assertQueuesExist(config) {
  const problems = findQueueProblems(config, (name) => {
    const args = ["exec", "wrangler", "queues", "info", name];
    globalThis.console.log(`[deploy-renderer] pnpm ${args.join(" ")}`);
    const result = spawnSync("pnpm", args, {
      cwd: dispatcherRoot,
      env: process.env,
      shell: false,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  });
  if (problems.missing.length > 0 || problems.unchecked.length > 0) {
    throw new Error(describeQueueProblems(problems));
  }
}

/** The stored record, or null before the first deploy that writes one. */
function readReleaseRecord(bucket) {
  const target = `${bucket}/${RENDERER_RELEASE_RECORD_KEY}`;
  const filePath = path.join(dispatcherRoot, "dist/release-record.download.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  const args = ["exec", "wrangler", "r2", "object", "get", target, "--file", filePath, "--remote"];
  globalThis.console.log(`[deploy-renderer] pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, {
    cwd: dispatcherRoot,
    env: process.env,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    if (isMissingObjectOutput(output)) {
      globalThis.console.log(
        `[deploy-renderer] No release record at ${target}; this deploy has no previous build.`,
      );
      return null;
    }
    globalThis.console.error(output);
    throw new Error(`Could not read ${target}. Fix access, or check the object.`);
  }
  return parseRendererReleaseRecord(readFileSync(filePath, "utf8"));
}

/**
 * Writes the record with retries (FC-M4). Returns false after the last failed
 * attempt, once the exact record and command are printed for the operator.
 */
async function writeReleaseRecord(bucket, record) {
  const filePath = path.join(dispatcherRoot, "dist/release-record.next.json");
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  const args = releaseRecordPutArgs(bucket, filePath);
  const result = await retryReleaseRecordWrite({
    attempt: (attempt) => {
      globalThis.console.log(
        `[deploy-renderer] (attempt ${attempt}) pnpm ${args.join(" ")}`,
      );
      return tryRun("pnpm", args, { cwd: dispatcherRoot });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (result.ok) return true;
  globalThis.console.error(
    `[deploy-renderer] ${describeReleaseRecordWriteFailure({
      bucket,
      record,
      filePath,
      cwd: dispatcherRoot,
      attempts: result.attempts,
    })}`,
  );
  return false;
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

/** Like `run`, but reports a failed command instead of exiting. */
function tryRun(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    globalThis.console.error(`[deploy-renderer] ${result.error.message}`);
    return false;
  }
  return result.status === 0;
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
  --prerender-mode <mode>     Saved-output rollout: off, allowlist, or all.
                              Default: the dispatcher wrangler.json value
  --prerender-site-ids <ids>  Site IDs used by pre-render allowlist mode
  --repair-enabled <boolean>  Enable or disable request-time repairs
  --route-data-cache-mode <mode>
                              Lazy route-data cache rollout: off, allowlist, or all.
                              Default: all
  --route-data-cache-site-ids <ids>
                              Site IDs used by route-data cache allowlist mode
  --previous-fallback <on|off>
                              Required. on: the build this deploy replaces stays
                              the cached fallback for 24 hours (M26). off: no
                              fallback (a security fix, or a bad build).
                              A rollback to the previous release is off
                              automatically.
  --revoke <releaseId>        Never use this renderer release as the previous
                              build again. Repeatable.
  --config <path>             Shared renderer source config
  --generated-config <path>   Shared renderer generated config
  --dry-run                   Build, package, and validate without deploying
  --stage                     Release step: upload the renderer, dispatcher and
                              prerenderer as versions without traffic, for the
                              flip (scripts/deploy/release.mjs). Deploys no API.
  --skip-secret               Deprecated no-op kept for command compatibility
  -h, --help                  Show this help

Environment alternatives:
  DOXA_RENDERER_PREVIOUS_FALLBACK
  DOXA_PROD_DYNAMIC_RENDERER_MODE
  DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS
  DOXA_PROD_PRERENDER_MODE
  DOXA_PROD_PRERENDER_SITE_IDS
  DOXA_PRERENDER_REPAIR_ENABLED
  DOXA_PROD_ROUTE_DATA_CACHE_MODE
  DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS
`);
}
