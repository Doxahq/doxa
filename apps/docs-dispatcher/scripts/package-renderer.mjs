#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { init, parse } from "es-module-lexer";

import {
  parsePreviousFallbackOption,
  parseRendererReleaseRecord,
  parseRevokedReleaseId,
  planPreviousBuild,
  previousBuildVars,
} from "../../../scripts/lib/renderer-release-record.mjs";

const gzipAsync = promisify(gzip);
const SCHEMA_VERSION = 1;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const DEFAULT_SERVER_DIR = "../docs-template/dist/server";
const DEFAULT_CLIENT_DIR = "../docs-template/dist/client";
const DEFAULT_OUTPUT_DIR = "dist";
const DEFAULT_DISPATCHER_CONFIG = "wrangler.json";
const OUTPUT_SCHEMA_VERSION = 1;

export async function createRendererPackage(options) {
  const appRoot = path.resolve(options.appRoot);
  const serverDir = path.resolve(
    appRoot,
    options.serverDir ?? DEFAULT_SERVER_DIR,
  );
  const outputDir = path.resolve(
    appRoot,
    options.outputDir ?? DEFAULT_OUTPUT_DIR,
  );
  const clientDir = path.resolve(
    appRoot,
    options.clientDir ?? DEFAULT_CLIENT_DIR,
  );
  const dispatcherConfigPath = path.resolve(
    appRoot,
    options.dispatcherConfig ?? DEFAULT_DISPATCHER_CONFIG,
  );
  const serverConfig = await readJson(path.join(serverDir, "wrangler.json"));
  const dispatcherConfig = await readJson(dispatcherConfigPath);
  const modules = await readJavaScriptModules(serverDir);

  validateServerConfig(serverConfig, modules);
  await validateModuleGraph(modules);

  const packageWithoutId = {
    schemaVersion: SCHEMA_VERSION,
    compatibilityDate: requireString(
      serverConfig.compatibility_date,
      "renderer compatibility_date",
    ),
    compatibilityFlags: readStringArray(serverConfig.compatibility_flags),
    mainModule: requireString(serverConfig.main, "renderer main module"),
    modules,
  };
  const buildId = createHash("sha256")
    .update(JSON.stringify(packageWithoutId))
    .digest("hex");
  const clientAssetManifestDigest = await createDirectoryManifestDigest(
    clientDir,
  );
  const rendererReleaseId = createHash("sha256")
    .update(
      JSON.stringify({
        clientAssetManifestDigest,
        outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
        schemaVersion: 1,
        serverPackageDigest: buildId,
      }),
    )
    .digest("hex");
  const rendererPackage = { ...packageWithoutId, buildId };
  const rawPackage = Buffer.from(JSON.stringify(rendererPackage));
  if (rawPackage.byteLength > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      `Renderer package is ${formatBytes(rawPackage.byteLength)}; the limit is ${formatBytes(MAX_UNCOMPRESSED_BYTES)}.`,
    );
  }

  const compressedPackage = await gzipAsync(rawPackage, { level: 9, mtime: 0 });
  if (compressedPackage.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error(
      `Compressed renderer package is ${formatBytes(compressedPackage.byteLength)}; the limit is ${formatBytes(MAX_COMPRESSED_BYTES)}.`,
    );
  }

  const previousBuild = await planPackagePreviousBuild(options, {
    buildId,
    releaseId: rendererReleaseId,
  });
  const objectKey = `renderer-code/${buildId}.json.gz`;
  const packagePath = path.join(outputDir, `${buildId}.json.gz`);
  const generatedConfigPath = path.join(outputDir, "wrangler.production.json");
  const metadataPath = path.join(outputDir, "renderer-package.json");
  const generatedConfig = createGeneratedDispatcherConfig({
    config: dispatcherConfig,
    buildId,
    objectKey,
    mode: options.mode ?? "all",
    siteIds: options.siteIds ?? "",
    debug: normalizeDebug(
      options.debug ?? dispatcherConfig.vars?.DEBUG ?? "false",
    ),
    rendererReleaseId,
    // F1: without an explicit value, keep the committed rollout.
    prerenderMode:
      options.prerenderMode ??
      dispatcherConfig.vars?.DOXA_PROD_PRERENDER_MODE ??
      "off",
    prerenderSiteIds:
      options.prerenderSiteIds ??
      dispatcherConfig.vars?.DOXA_PROD_PRERENDER_SITE_IDS ??
      "",
    repairEnabled: normalizeBoolean(
      options.repairEnabled ?? "false",
      "DOXA_PRERENDER_REPAIR_ENABLED",
    ),
    routeDataCacheMode: options.routeDataCacheMode ?? "all",
    routeDataCacheSiteIds: options.routeDataCacheSiteIds ?? "",
    previousBuild,
  });

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(packagePath, compressedPackage),
    writeFile(
      generatedConfigPath,
      `${JSON.stringify(generatedConfig, null, 2)}\n`,
    ),
    writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          buildId,
          clientAssetManifestDigest,
          outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
          rendererReleaseId,
          objectKey,
          packagePath,
          generatedConfigPath,
          previousBuild,
          moduleCount: Object.keys(modules).length,
          uncompressedBytes: rawPackage.byteLength,
          compressedBytes: compressedPackage.byteLength,
        },
        null,
        2,
      )}\n`,
    ),
  ]);

  return {
    buildId,
    clientAssetManifestDigest,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    rendererReleaseId,
    objectKey,
    packagePath,
    generatedConfigPath,
    metadataPath,
    previousBuild,
    moduleCount: Object.keys(modules).length,
    uncompressedBytes: rawPackage.byteLength,
    compressedBytes: compressedPackage.byteLength,
  };
}

function createGeneratedDispatcherConfig(input) {
  validateMode(input.mode);
  validateMode(input.prerenderMode);
  validateMode(input.routeDataCacheMode);

  return {
    ...input.config,
    main: "../src/index.ts",
    assets: {
      ...input.config.assets,
      directory: "../../docs-template/dist/client",
    },
    vars: {
      ...input.config.vars,
      DEBUG: input.debug,
      DOXA_PROD_DYNAMIC_RENDERER_MODE: input.mode,
      DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS: input.siteIds,
      DOXA_RENDERER_BUILD_ID: input.buildId,
      DOXA_RENDERER_PACKAGE_KEY: input.objectKey,
      DOXA_RENDERER_RELEASE_ID: input.rendererReleaseId,
      DOXA_PROD_PRERENDER_MODE: input.prerenderMode,
      DOXA_PROD_PRERENDER_SITE_IDS: input.prerenderSiteIds,
      DOXA_PRERENDER_REPAIR_ENABLED: input.repairEnabled,
      DOXA_PROD_ROUTE_DATA_CACHE_MODE: input.routeDataCacheMode,
      DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS: input.routeDataCacheSiteIds,
      ...previousBuildVars(input.previousBuild),
    },
  };
}

/**
 * The previous build for the dispatcher (M26). Without `previousFallback`
 * (a package outside a deploy) the vars stay empty.
 */
async function planPackagePreviousBuild(options, current) {
  if (options.previousFallback === undefined) {
    return { previous: null, reason: "not_requested", deployedAt: "" };
  }
  const record = options.releaseRecordPath
    ? parseRendererReleaseRecord(
        await readFile(path.resolve(options.releaseRecordPath), "utf8"),
      )
    : null;
  return planPreviousBuild({
    record,
    current,
    previousFallback: parsePreviousFallbackOption(options.previousFallback),
    revoke: (options.revoke ?? []).map(parseRevokedReleaseId),
    now: options.now ?? new Date().toISOString(),
  });
}

// The release ID must change only when rendered HTML would change. HTML links
// to the content-hashed files under assets/ by name. Fixed-name files keep
// their URLs, and the template's own pages.json and sitemap.xml change on
// every build, which would empty the docs cache on every deploy.
const CLIENT_DIGEST_DIR = "assets";

async function createDirectoryManifestDigest(directory) {
  const assetsDirectory = path.join(directory, CLIENT_DIGEST_DIR);
  const files = (await listFiles(assetsDirectory).catch(() => [])).sort();
  if (files.length === 0) {
    throw new Error(`No client assets found in ${assetsDirectory}.`);
  }
  const entries = await Promise.all(
    files.map(async (filePath) => {
      const bytes = await readFile(filePath);
      return {
        path: toModuleName(directory, filePath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    }),
  );
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

async function readJavaScriptModules(serverDir) {
  const filePaths = await listFiles(serverDir);
  const modulePaths = filePaths
    .filter((filePath) => filePath.endsWith(".js") || filePath.endsWith(".mjs"))
    .sort();
  if (modulePaths.length === 0) {
    throw new Error(`No renderer JavaScript modules found in ${serverDir}.`);
  }

  return Object.fromEntries(
    await Promise.all(
      modulePaths.map(async (filePath) => [
        toModuleName(serverDir, filePath),
        await readFile(filePath, "utf8"),
      ]),
    ),
  );
}

async function validateModuleGraph(modules) {
  await init;
  const moduleNames = new Set(Object.keys(modules));

  for (const [moduleName, source] of Object.entries(modules)) {
    const [imports] = parse(source);
    for (const entry of imports) {
      if (!entry.n || !entry.n.startsWith(".")) continue;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(moduleName), entry.n),
      );
      if (!moduleNames.has(target)) {
        throw new Error(
          `Renderer module ${moduleName} imports missing module ${entry.n}.`,
        );
      }
    }
  }
}

function validateServerConfig(config, modules) {
  const mainModule = requireString(config.main, "renderer main module");
  if (!(mainModule in modules)) {
    throw new Error(`Renderer main module is missing: ${mainModule}.`);
  }
  requireString(config.compatibility_date, "renderer compatibility_date");
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(entryPath);
      if (!entry.isFile()) return [];
      return [entryPath];
    }),
  );
  return nested.flat();
}

function toModuleName(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function readJson(filePath) {
  const file = await stat(filePath).catch(() => null);
  if (!file?.isFile()) throw new Error(`Missing required file: ${filePath}.`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

function requireString(value, label) {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Missing ${label}.`);
}

function readStringArray(value) {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value];
  }
  throw new Error("Renderer compatibility_flags must contain only strings.");
}

function validateMode(mode) {
  if (mode === "off" || mode === "allowlist" || mode === "all") return;
  throw new Error(
    `Invalid dynamic renderer mode ${JSON.stringify(mode)}. Expected off, allowlist, or all.`,
  );
}

function normalizeDebug(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "true" || normalized === "false") return normalized;
  throw new Error(
    `Invalid DEBUG value ${JSON.stringify(value)}. Expected true or false.`,
  );
}

function normalizeBoolean(value, label) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "true" || normalized === "false") return normalized;
  throw new Error(
    `Invalid ${label} value ${JSON.stringify(value)}. Expected true or false.`,
  );
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function parseRendererPackageArgs(args, environment = process.env) {
  const options = {
    appRoot: process.cwd(),
    mode: environment.DOXA_PROD_DYNAMIC_RENDERER_MODE ?? "all",
    siteIds: environment.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS ?? "",
    debug: environment.DEBUG,
    // Unset falls back to the dispatcher config's vars (F1).
    prerenderMode: readOptionalEnv(environment.DOXA_PROD_PRERENDER_MODE),
    prerenderSiteIds: readOptionalEnv(
      environment.DOXA_PROD_PRERENDER_SITE_IDS,
    ),
    repairEnabled: environment.DOXA_PRERENDER_REPAIR_ENABLED ?? "false",
    routeDataCacheMode: environment.DOXA_PROD_ROUTE_DATA_CACHE_MODE ?? "all",
    routeDataCacheSiteIds: environment.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS ?? "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--app-root") options.appRoot = readArg(args, ++index, arg);
    else if (arg === "--server-dir")
      options.serverDir = readArg(args, ++index, arg);
    else if (arg === "--output-dir")
      options.outputDir = readArg(args, ++index, arg);
    else if (arg === "--client-dir")
      options.clientDir = readArg(args, ++index, arg);
    else if (arg === "--config")
      options.dispatcherConfig = readArg(args, ++index, arg);
    else if (arg === "--mode") options.mode = readArg(args, ++index, arg);
    else if (arg === "--site-ids")
      options.siteIds = readArg(args, ++index, arg);
    else if (arg === "--debug") options.debug = readArg(args, ++index, arg);
    else if (arg === "--prerender-mode")
      options.prerenderMode = readArg(args, ++index, arg);
    else if (arg === "--prerender-site-ids")
      options.prerenderSiteIds = readArg(args, ++index, arg);
    else if (arg === "--repair-enabled")
      options.repairEnabled = readArg(args, ++index, arg);
    else if (arg === "--route-data-cache-mode")
      options.routeDataCacheMode = readArg(args, ++index, arg);
    else if (arg === "--route-data-cache-site-ids")
      options.routeDataCacheSiteIds = readArg(args, ++index, arg);
    else if (arg === "--previous-fallback")
      options.previousFallback = readArg(args, ++index, arg);
    else if (arg === "--release-record")
      options.releaseRecordPath = readArg(args, ++index, arg);
    else if (arg === "--revoke")
      options.revoke = [...(options.revoke ?? []), readArg(args, ++index, arg)];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function readOptionalEnv(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

async function main() {
  const result = await createRendererPackage(
    parseRendererPackageArgs(process.argv.slice(2)),
  );
  globalThis.console.log(
    `[renderer-package] ${result.buildId} (${result.moduleCount} modules, ${formatBytes(result.compressedBytes)} compressed)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    globalThis.console.error(
      `[renderer-package] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
