import {
  docsHostResolutionSchema,
  type DocsHostResolution,
  type InternalApiRpc,
} from "@doxahq/contracts";
import {
  SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS,
  buildArtifactPrefix,
  manifestPathForPrefix,
  parseDocsManifestText,
  type DocsManifest,
  type VersionObjectFetcher,
  type VersionTreeReader,
} from "@doxahq/docs-engine";
import { z } from "zod";
import {
  assetUrl,
  resolveHomeHref,
  type ResolvedSiteConfig,
} from "@doxahq/site-config";
import {
  readSiteConfig,
  resetSiteConfigCacheForTests,
  runtimeFeatures,
} from "./site-config";
import {
  DocsResolverClient,
  type DocsResolverBinding,
} from "@doxahq/contracts/docs-resolver";
import {
  readDocsRuntimeTrace,
  type DocsRuntimeCallTiming,
  type DocsRuntimeIsolateFacts,
  type DocsRuntimeTrace,
} from "@doxahq/contracts/docs-runtime-trace";
import {
  artifactReader,
  type ArtifactReadSource,
  type ArtifactStorageEnv,
} from "./artifact-storage";
import { readPageAssetVersions } from "./page-assets";
import {
  markVersionSeen,
  recordIsolateRequest,
  toCallTiming,
  traceLogFields,
  type RuntimeCallMeasurements,
} from "./runtime-trace";

const docsResolutionResponseSchema = z
  .object({
    site: docsHostResolutionSchema,
  })
  .strict();

export interface RuntimeSourceEnv extends ArtifactStorageEnv {
  DOCS_RESOLVER?: DocsResolverBinding;
  API?: InternalApiRpc;
  ALLOW_INTERNAL_HTTP?: string;
  API_BASE_URL?: string;
  DOCS_CONTENT_TOKEN?: string;
  DOCS_PUBLIC_BASE_URL?: string;
  DOXA_DOCS_RUNTIME_TIMING?: string;
}

type RuntimeOperation =
  | "getResolvedSiteConfig"
  | "getSiteConfig"
  | "getCompanyConfig"
  | "getSocialConfig"
  | "getThemeConfig"
  | "getFeatureConfig"
  | "getSections"
  | "getNavigation"
  | "getRoutes"
  | "getHomeHref"
  | "getRouteData"
  | "resolvePage"
  | "getPage"
  | "getRawPage"
  | "getSearchIndex"
  | "getCompiledSearchIndex"
  | "getPrerenderPlan";

export interface RuntimeRequest {
  operation: RuntimeOperation;
  payload?: unknown;
}

export interface ResolvedRuntimeRequest extends RuntimeRequest {
  resolution: DocsHostResolution;
  /**
   * Set by the dispatcher (M39). It crosses an RPC boundary, so it is parsed
   * before use; an invalid trace counts as none.
   */
  trace?: unknown;
}

export interface HostRuntimeRequest extends RuntimeRequest {
  hostname: string;
}

interface RuntimeSection {
  slug: string;
  label: string;
  description?: string;
  icon?: string;
  default?: boolean;
  hidden?: boolean;
  kind?: "documentation" | "reference" | "development";
  layout?: "docs" | "reference";
}

interface RuntimeNavPage {
  title: string;
  href: string;
  icon?: string;
  badge?: string;
  noLink?: true;
  heading?: string;
  items?: RuntimeNavNode[];
}

interface RuntimeNavHeading {
  heading: string;
}

interface RuntimeNavSpacer {
  spacer: true;
}

type RuntimeNavNode = RuntimeNavPage | RuntimeNavHeading | RuntimeNavSpacer;

interface RuntimePage {
  slug: string;
  href: string;
  title: string;
  description: string;
  keywords: string[];
  sectionSlug: string;
  sourcePath: string;
  body: string;
  headings: Array<{
    level: number;
    text: string;
    href: string;
  }>;
  apiMethod?: string;
  apiPath?: string;
  /** Content hash by asset name, for each asset the page links to. */
  assets?: Record<string, string>;
}

interface RuntimeRawPage {
  slug: string;
  href: string;
  title: string;
  description: string;
  sourcePath: string;
  body: string;
  apiMethod?: string;
  apiPath?: string;
}

type RuntimePageResolution =
  | {
      type: "page";
      href: string;
      slug: string;
      page: RuntimePage;
    }
  | RuntimeRouteRedirectData
  | {
      type: "not_found";
      href: string;
      slug: string;
    };

type RuntimeRouteData =
  | RuntimeRouteRedirectData
  | RuntimeRouteRouterNotFoundData
  | RuntimeRoutePageData;

interface RuntimeRouteRedirectData {
  type: "redirect";
  href: string;
  status: 301 | 302 | 303 | 307 | 308;
}

interface RuntimeRouteRouterNotFoundData {
  type: "router_not_found";
  href: string;
  slug: string;
}

interface RuntimeRoutePageData {
  type: "page" | "not_found";
  slug: string;
  href: string;
  homeHref: string | null;
  siteConfig?: ResolvedSiteConfig;
  site: RuntimeSiteConfig;
  features: RuntimeFeatureConfig;
  sections: RuntimeSection[];
  currentSection: RuntimeSection | null;
  sectionHomeHrefs: Record<string, string>;
  sectionNavigation: RuntimeNavNode[];
  sectionRoutes: RuntimeNavPage[];
  routeTitle: string | null;
  sectionHeading: string | null;
  previous: RuntimeNavPage | null;
  next: RuntimeNavPage | null;
  page: RuntimePage | null;
}

interface RuntimeSiteConfig {
  name: string;
  description: string;
  url: string;
}

interface RuntimeFeatureConfig {
  branding: boolean;
  rightSidebar: boolean;
  feedbackEdit: boolean;
  tableOfContents: boolean;
  scrollToTop: boolean;
  ai: {
    chat: boolean;
    chatWithPage: boolean;
    floatingInput: boolean;
  };
  copyPage: {
    markdown: boolean;
    rawText: boolean;
  };
  apiPlayground: boolean;
  /** The owner's "Try it" target (SEC-010); unset turns Try it off. */
  apiPlaygroundBaseUrl?: string;
  rawMarkdown: boolean;
  loadFromGithub: boolean;
}

interface Frontmatter {
  title: string;
  description: string;
  keywords: string[];
  apiMethod?: string;
  apiPath?: string;
}

export interface ProjectRuntimeContext {
  projectId: string;
  projectSlug: string;
  artifactPrefix: string;
  manifestPath: string;
  manifest: DocsManifest;
  /** The public origin of the requesting hostname, set by the dispatcher. */
  siteUrl?: string;
}

/**
 * The outcome of reading one `manifest.json`. A manifest written for a newer
 * artifact schema is reported on its own so that the failure is visible as a
 * renderer/writer mismatch, never as a missing version.
 */
type DocsManifestReadResult =
  | { status: "ok"; manifest: DocsManifest }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "unsupported_schema"; schemaVersion: number };

type ProjectRuntimeContextResult =
  | { ok: true; context: ProjectRuntimeContext }
  | { ok: false; failure: RuntimeContextFailure };

interface RuntimeContextFailure {
  code:
    | "project_not_found"
    | "version_not_found"
    | "unsupported_artifact_schema";
  message: string;
  status: 404 | 500;
}

type RuntimeScope =
  | {
      kind: "project";
      value: string;
    }
  | {
      kind: "host";
      value: string;
    };

type RuntimeSuccess = {
  ok: true;
  data: unknown;
};

type RuntimeFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

/** `timing` is present only when the call carried a valid trace. */
export type RuntimeResponseBody = (RuntimeSuccess | RuntimeFailure) & {
  timing?: DocsRuntimeCallTiming;
};
type DocsRuntimeResolution = NonNullable<
  Awaited<
    ReturnType<NonNullable<RuntimeSourceEnv["API"]>["resolveDocsProject"]>
  >
>;

const DEFAULT_RUNTIME_PATH = "/runtime-source";
const DEFAULT_SECTION: RuntimeSection = {
  slug: "default",
  label: "Docs",
  default: true,
  kind: "documentation",
  layout: "docs",
};
const RUNTIME_CACHE_TTL_MS = 60_000;
const RUNTIME_CACHE_MAX_ENTRIES = 500;

export interface RuntimeRequestContext {
  timing: RuntimeTiming;
  cache: RuntimeRequestCache;
  reads: RuntimeReadStats;
  /** The artifact reader of this request. It counts its storage reads. */
  artifacts: VersionTreeReader;
}

/** Artifact reads that passed the memory caches during one request. */
interface RuntimeReadStats {
  count: number;
  totalMs: number;
  longestMs: number;
  /** Storage reads by where they were served. */
  sources: Record<ArtifactReadSource, number>;
  /** When the first storage read of the request ended. */
  firstReadEndedAt?: number;
}

export function recordArtifactRead(
  runtimeContext: RuntimeRequestContext,
  durationMs: number,
): void {
  const { reads } = runtimeContext;
  reads.count += 1;
  reads.firstReadEndedAt ??= now();
  reads.totalMs += durationMs;
  reads.longestMs = Math.max(reads.longestMs, durationMs);
}

interface RuntimeRequestCache {
  resolutions: Map<string, Promise<DocsRuntimeResolution | null>>;
  manifests: Map<string, Promise<DocsManifestReadResult>>;
  artifacts: Map<string, Promise<string | null>>;
  sections: Map<string, Promise<RuntimeSection[]>>;
  navigation: Map<string, Promise<RuntimeNavNode[]>>;
  routes: Map<string, Promise<RuntimeNavPage[]>>;
}

interface RuntimeModuleCaches {
  manifests: Map<string, RuntimeCacheEntry<DocsManifestReadResult>>;
  artifacts: Map<string, RuntimeCacheEntry<string | null>>;
  sections: Map<string, RuntimeCacheEntry<RuntimeSection[]>>;
  navigation: Map<string, RuntimeCacheEntry<RuntimeNavNode[]>>;
  routes: Map<string, RuntimeCacheEntry<RuntimeNavPage[]>>;
}

interface RuntimeCacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

const runtimeModuleCaches: RuntimeModuleCaches = {
  manifests: new Map(),
  artifacts: new Map(),
  sections: new Map(),
  navigation: new Map(),
  routes: new Map(),
};

interface RuntimeTiming {
  enabled: boolean;
  mark(event: string, data?: RuntimeTimingData): void;
  measure<T>(
    event: string,
    operation: () => T | Promise<T>,
    data?: RuntimeTimingData,
  ): Promise<T>;
}

type RuntimeTimingData = Record<
  string,
  boolean | number | string | null | undefined
>;

/**
 * `blobCache` is `ctx.exports.DocsBlobCache` of the current request. Without
 * it, the reader reads R2.
 */
function createRuntimeRequestContext(
  env: RuntimeSourceEnv,
  blobCache: VersionObjectFetcher | null,
): RuntimeRequestContext {
  const reads: RuntimeReadStats = {
    count: 0,
    totalMs: 0,
    longestMs: 0,
    sources: { edgeCache: 0, blobCache: 0, r2: 0 },
  };
  return {
    timing: createRuntimeTiming(env),
    reads,
    artifacts: artifactReader(env, {
      blobCache,
      onRead: (source) => {
        reads.sources[source] += 1;
      },
    }),
    cache: {
      resolutions: new Map(),
      manifests: new Map(),
      artifacts: new Map(),
      sections: new Map(),
      navigation: new Map(),
      routes: new Map(),
    },
  };
}

export function resetRuntimeSourceCachesForTests(): void {
  resetSiteConfigCacheForTests();
  runtimeModuleCaches.manifests.clear();
  runtimeModuleCaches.artifacts.clear();
  runtimeModuleCaches.sections.clear();
  runtimeModuleCaches.navigation.clear();
  runtimeModuleCaches.routes.clear();
}

export async function handleRuntimeSourceRequest(
  request: Request,
  env: RuntimeSourceEnv,
  blobCache: VersionObjectFetcher | null = null,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") !== DEFAULT_RUNTIME_PATH) return null;
  const requestStartedAt = now();
  const runtimeContext = createRuntimeRequestContext(env, blobCache);
  const { timing } = runtimeContext;

  if (request.method !== "POST") {
    timing.mark("request.complete", {
      status: 405,
      ok: false,
      durationMs: elapsed(requestStartedAt),
    });
    return jsonError(
      "method_not_allowed",
      "Runtime source only accepts POST requests.",
      405,
    );
  }

  const authError = await authenticateRuntimeRequest(request, env);
  if (authError) {
    timing.mark("request.complete", {
      status: authError.status,
      ok: false,
      durationMs: elapsed(requestStartedAt),
    });
    return authError;
  }

  const scope = getRuntimeScope(request);
  if (!scope) {
    timing.mark("request.complete", {
      status: 400,
      ok: false,
      durationMs: elapsed(requestStartedAt),
    });
    return jsonError(
      "missing_runtime_scope",
      "Missing x-doxa-host or x-doxa-project-id header.",
      400,
    );
  }

  const runtimeRequest = await readRuntimeRequest(request);
  if (!runtimeRequest) {
    timing.mark("request.complete", {
      status: 400,
      ok: false,
      scopeKind: scope.kind,
      durationMs: elapsed(requestStartedAt),
    });
    return jsonError(
      "invalid_request",
      "Expected a runtime operation JSON body.",
      400,
    );
  }
  timing.mark("request.start", {
    operation: runtimeRequest.operation,
    scopeKind: scope.kind,
  });

  const loaded = await loadProjectRuntimeContext(env, scope, runtimeContext);
  if (!loaded.ok) {
    timing.mark("request.complete", {
      operation: runtimeRequest.operation,
      status: loaded.failure.status,
      ok: false,
      scopeKind: scope.kind,
      durationMs: elapsed(requestStartedAt),
    });
    return jsonError(
      loaded.failure.code,
      loaded.failure.message,
      loaded.failure.status,
    );
  }
  const { context } = loaded;

  try {
    const data = await timing.measure(
      "operation.run",
      () => runRuntimeOperation(env, context, runtimeRequest, runtimeContext),
      { operation: runtimeRequest.operation },
    );
    timing.mark("request.complete", {
      operation: runtimeRequest.operation,
      status: 200,
      ok: true,
      scopeKind: scope.kind,
      durationMs: elapsed(requestStartedAt),
      responseBytes: estimateJsonSize({ ok: true, data }),
    });
    return json({ ok: true, data });
  } catch (error) {
    timing.mark("request.complete", {
      operation: runtimeRequest.operation,
      status: 500,
      ok: false,
      scopeKind: scope.kind,
      durationMs: elapsed(requestStartedAt),
      errorName:
        error instanceof Error ? error.name || "Error" : "UnknownError",
    });
    return jsonError(
      "operation_failed",
      error instanceof Error ? error.message : "Runtime operation failed.",
      500,
    );
  }
}

export async function runResolvedRuntimeRequest(
  env: RuntimeSourceEnv,
  input: ResolvedRuntimeRequest,
  blobCache: VersionObjectFetcher | null = null,
): Promise<RuntimeResponseBody> {
  const startedAt = now();
  const isolate = recordIsolateRequest(startedAt);
  const trace = readDocsRuntimeTrace(input.trace);
  const operation = isRuntimeOperation(input.operation)
    ? input.operation
    : null;
  const resolution = docsHostResolutionSchema.safeParse(input.resolution);
  if (!resolution.success || !operation) {
    logRuntimeFailure({
      errorCode: "invalid_request",
      operation,
      resolution: resolution.success ? resolution.data : null,
      trace,
      isolate,
    });
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message:
          "Expected a valid pinned docs resolution and runtime operation.",
      },
    };
  }

  const versionColdInIsolate = markVersionSeen(
    resolution.data.publishedVersionId,
  );
  const runtimeContext = createRuntimeRequestContext(env, blobCache);
  const manifestStartedAt = now();
  const manifestRead = await readManifest(
    env,
    resolution.data.manifestPath,
    runtimeContext,
  );
  const manifestMs = elapsed(manifestStartedAt);
  const measure = (
    operationMs: number,
    responseBytes?: number,
  ): RuntimeCallMeasurements => ({
    ...readMeasurements(runtimeContext),
    startedAt,
    finishedAt: now(),
    manifestMs,
    operationMs,
    ...(responseBytes === undefined ? {} : { responseBytes }),
    versionColdInIsolate,
    isolate,
  });
  if (manifestRead.status === "unsupported_schema") {
    return withCallTiming(
      { ok: false, error: unsupportedArtifactSchemaError(manifestRead) },
      trace,
      measure(0),
    );
  }
  if (
    manifestRead.status !== "ok" ||
    !isPinnedManifest(manifestRead.manifest, resolution.data)
  ) {
    logRuntimeFailure({
      errorCode: "version_not_found",
      operation,
      resolution: resolution.data,
      trace,
      isolate,
      manifestMs,
      versionColdInIsolate,
    });
    return withCallTiming(
      {
        ok: false,
        error: {
          code: "version_not_found",
          message: "The pinned documentation version is unavailable.",
        },
      },
      trace,
      measure(0),
    );
  }

  const context: ProjectRuntimeContext = {
    projectId: resolution.data.projectId,
    projectSlug: resolution.data.projectSlug,
    artifactPrefix: resolution.data.artifactPrefix,
    manifestPath: resolution.data.manifestPath,
    manifest: manifestRead.manifest,
    ...(resolution.data.siteUrl ? { siteUrl: resolution.data.siteUrl } : {}),
  };

  const operationStartedAt = now();
  const result = await runLoadedRuntimeRequest(
    env,
    context,
    input,
    runtimeContext,
  );
  const operationMs = elapsed(operationStartedAt);
  const isRouteData = operation === "getRouteData";
  // Sized only for a traced route-data call: the size costs a serialization.
  const measured = measure(
    operationMs,
    isRouteData && trace && result.ok
      ? estimateJsonSize(result.data)
      : undefined,
  );
  if (isRouteData) {
    logRouteDataReads(resolution.data, runtimeContext, result.ok, {
      trace,
      measured,
    });
  }
  return withCallTiming(result, trace, measured);
}

function readMeasurements(
  runtimeContext: RuntimeRequestContext,
): Pick<
  RuntimeCallMeasurements,
  "firstReadEndedAt" | "reads" | "r2Reads" | "readMs"
> {
  const { reads } = runtimeContext;
  return {
    ...(reads.firstReadEndedAt === undefined
      ? {}
      : { firstReadEndedAt: reads.firstReadEndedAt }),
    reads: reads.count,
    r2Reads: reads.sources.r2,
    readMs: reads.totalMs,
  };
}

/** Adds `timing` only for a traced call, so an old dispatcher gets the old answer. */
function withCallTiming(
  result: RuntimeResponseBody,
  trace: DocsRuntimeTrace | undefined,
  measured: RuntimeCallMeasurements,
): RuntimeResponseBody {
  return trace ? { ...result, timing: toCallTiming(measured) } : result;
}

/**
 * One `docs_runtime_reads` line for a call that failed before its operation.
 * It never logs the payload or the raw input: only IDs from a valid
 * resolution and a known operation name.
 */
function logRuntimeFailure(input: {
  errorCode: "invalid_request" | "version_not_found";
  operation: RuntimeOperation | null;
  resolution: DocsHostResolution | null;
  trace: DocsRuntimeTrace | undefined;
  isolate: DocsRuntimeIsolateFacts;
  manifestMs?: number;
  versionColdInIsolate?: boolean;
}): void {
  console.warn(
    JSON.stringify({
      event: "docs_runtime_reads",
      operation: input.operation,
      siteId: input.resolution?.siteId ?? null,
      publishedVersionId: input.resolution?.publishedVersionId ?? null,
      ok: false,
      errorCode: input.errorCode,
      ...traceLogFields(input.trace),
      isolate: input.isolate,
      ...(input.manifestMs === undefined
        ? {}
        : { manifestMs: Math.round(input.manifestMs) }),
      ...(input.versionColdInIsolate === undefined
        ? {}
        : { versionColdInIsolate: input.versionColdInIsolate }),
    }),
  );
}

/**
 * One line per route-data read, with or without DOXA_DOCS_RUNTIME_TIMING.
 * The dispatcher calls getRouteData only on an HTML or route-data cache miss,
 * so the volume follows the misses. The read count includes the manifest
 * reads made before the operation. `edgeCacheHits`, `blobCacheHits` and
 * `r2Reads` split the storage reads below those reads (a tree, a blob) by
 * where they were served; a tiered-cache miss is an R2 read. `traceId` and
 * `caller` come from the dispatcher's trace, when the call carried one.
 */
function logRouteDataReads(
  resolution: DocsHostResolution,
  runtimeContext: RuntimeRequestContext,
  ok: boolean,
  call: {
    trace: DocsRuntimeTrace | undefined;
    measured: RuntimeCallMeasurements;
  },
): void {
  const { reads } = runtimeContext;
  const { measured } = call;
  console.info(
    JSON.stringify({
      event: "docs_runtime_reads",
      operation: "getRouteData",
      siteId: resolution.siteId,
      publishedVersionId: resolution.publishedVersionId,
      ok,
      reads: reads.count,
      readMs: Math.round(reads.totalMs),
      longestReadMs: Math.round(reads.longestMs),
      edgeCacheHits: reads.sources.edgeCache,
      blobCacheHits: reads.sources.blobCache,
      r2Reads: reads.sources.r2,
      ...traceLogFields(call.trace),
      isolate: measured.isolate,
      manifestMs: Math.round(measured.manifestMs),
      operationMs: Math.round(measured.operationMs),
      versionColdInIsolate: measured.versionColdInIsolate,
    }),
  );
}

function isPinnedManifest(
  manifest: DocsManifest,
  resolution: DocsHostResolution,
): boolean {
  const artifactPrefix = buildArtifactPrefix(
    manifest.siteId,
    manifest.versionId,
  );

  return (
    manifest.siteId === resolution.siteId &&
    resolution.artifactPrefix === artifactPrefix &&
    resolution.manifestPath === manifestPathForPrefix(artifactPrefix)
  );
}

export async function runHostRuntimeRequest(
  env: RuntimeSourceEnv,
  input: HostRuntimeRequest,
  blobCache: VersionObjectFetcher | null = null,
): Promise<RuntimeResponseBody> {
  const hostname = input.hostname?.trim().toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    !isRuntimeOperation(input.operation)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "Expected a valid docs hostname and runtime operation.",
      },
    };
  }

  const runtimeContext = createRuntimeRequestContext(env, blobCache);
  const loaded = await loadProjectRuntimeContext(
    env,
    { kind: "host", value: hostname },
    runtimeContext,
  );
  if (!loaded.ok) {
    return {
      ok: false,
      error: {
        code: loaded.failure.code,
        message:
          loaded.failure.code === "project_not_found"
            ? "No published docs were found for this hostname."
            : loaded.failure.message,
      },
    };
  }

  return runLoadedRuntimeRequest(env, loaded.context, input, runtimeContext);
}

async function runLoadedRuntimeRequest(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  input: RuntimeRequest,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeResponseBody> {
  try {
    const data = await runRuntimeOperation(env, context, input, runtimeContext);
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "operation_failed",
        message:
          error instanceof Error ? error.message : "Runtime operation failed.",
      },
    };
  }
}

export async function authenticateRuntimeRequest(
  request: Request,
  env: RuntimeSourceEnv,
): Promise<Response | null> {
  const expectedToken = env.DOCS_CONTENT_TOKEN?.trim();
  if (!expectedToken) {
    return jsonError(
      "runtime_token_not_configured",
      "Runtime content token is not configured.",
      500,
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
  if (!(await timingSafeEqual(candidate, expectedToken))) {
    return jsonError("unauthorized", "Unauthorized.", 401);
  }

  return null;
}

async function readRuntimeRequest(
  request: Request,
): Promise<RuntimeRequest | null> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") return null;

    const record = body as Record<string, unknown>;
    if (!isRuntimeOperation(record.operation)) return null;

    return {
      operation: record.operation,
      ...(record.payload === undefined ? {} : { payload: record.payload }),
    };
  } catch {
    return null;
  }
}

function isRuntimeOperation(value: unknown): value is RuntimeOperation {
  return (
    value === "getResolvedSiteConfig" ||
    value === "getSiteConfig" ||
    value === "getCompanyConfig" ||
    value === "getSocialConfig" ||
    value === "getThemeConfig" ||
    value === "getFeatureConfig" ||
    value === "getSections" ||
    value === "getNavigation" ||
    value === "getRoutes" ||
    value === "getHomeHref" ||
    value === "getRouteData" ||
    value === "resolvePage" ||
    value === "getPage" ||
    value === "getRawPage" ||
    value === "getSearchIndex" ||
    value === "getCompiledSearchIndex" ||
    value === "getPrerenderPlan"
  );
}

async function loadProjectRuntimeContext(
  env: RuntimeSourceEnv,
  scope: RuntimeScope,
  runtimeContext: RuntimeRequestContext,
): Promise<ProjectRuntimeContextResult> {
  const { timing } = runtimeContext;
  const resolution = await readRequestCached(
    runtimeContext.cache.resolutions,
    getResolutionCacheKey(scope),
    () =>
      scope.kind === "host"
        ? timing.measure("context.resolveHost", () =>
            resolveDocsHost(env, scope.value),
          )
        : timing.measure("context.resolveProject", () =>
            resolveDocsProject(env, scope.value),
          ),
    timing,
    { cacheKind: "resolution", scopeKind: scope.kind },
  );
  if (!resolution) return { ok: false, failure: PROJECT_NOT_FOUND_FAILURE };

  const manifestRead = await timing.measure(
    "context.readManifest",
    () => readManifest(env, resolution.manifestPath, runtimeContext),
    { artifactKind: "manifest" },
  );
  if (manifestRead.status === "unsupported_schema") {
    return {
      ok: false,
      failure: {
        ...unsupportedArtifactSchemaError(manifestRead),
        status: 500,
      },
    };
  }
  if (manifestRead.status !== "ok") {
    return { ok: false, failure: PROJECT_NOT_FOUND_FAILURE };
  }

  return {
    ok: true,
    context: {
      projectId: resolution.projectId,
      projectSlug: resolution.projectSlug,
      artifactPrefix: resolution.artifactPrefix,
      manifestPath: resolution.manifestPath,
      manifest: manifestRead.manifest,
    },
  };
}

const PROJECT_NOT_FOUND_FAILURE: RuntimeContextFailure = {
  code: "project_not_found",
  message: "No published docs were found for this project.",
  status: 404,
};

function unsupportedArtifactSchemaError(read: {
  schemaVersion: number;
}): RuntimeFailure["error"] & { code: "unsupported_artifact_schema" } {
  return {
    code: "unsupported_artifact_schema",
    message: `The published documentation uses artifact schema version ${read.schemaVersion}. This renderer supports versions ${SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS.join(", ")}.`,
  };
}

export function getRuntimeScope(request: Request): RuntimeScope | null {
  const hostname = request.headers.get("x-doxa-host")?.trim();
  if (hostname) {
    return { kind: "host", value: hostname };
  }

  const projectId = request.headers.get("x-doxa-project-id")?.trim();
  return projectId ? { kind: "project", value: projectId } : null;
}

function getResolutionCacheKey(scope: RuntimeScope): string {
  const value = scope.kind === "host" ? scope.value.toLowerCase() : scope.value;
  return `resolution:${scope.kind}:${value}`;
}

export async function resolveDocsHost(env: RuntimeSourceEnv, hostname: string) {
  if (env.DOCS_RESOLVER) {
    return new DocsResolverClient(env.DOCS_RESOLVER).resolveDocsHost(hostname);
  }
  // Local development keeps the existing API transport. Production binds the resolver.
  if (env.API) {
    try {
      return await env.API.resolveDocsHost(hostname);
    } catch {
      if (!isInternalHttpFallbackAllowed(env)) return null;
    }
  }

  if (!isInternalHttpFallbackAllowed(env)) return null;

  const response = await fetchFromApiBaseUrl(
    env,
    `/internal/docs-hosts/${encodeURIComponent(hostname)}`,
  );
  if (!response.ok) return null;

  const payload: unknown = await response.json();
  const parsed = docsResolutionResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.site : null;
}

export async function resolveDocsProject(
  env: RuntimeSourceEnv,
  projectId: string,
) {
  if (env.DOCS_RESOLVER) {
    return new DocsResolverClient(env.DOCS_RESOLVER).resolveDocsProject(
      projectId,
    );
  }
  if (env.API) {
    try {
      return await env.API.resolveDocsProject(projectId);
    } catch {
      if (!isInternalHttpFallbackAllowed(env)) return null;
    }
  }

  if (!isInternalHttpFallbackAllowed(env)) return null;

  const response = await fetchFromApiBaseUrl(
    env,
    `/internal/docs-projects/${encodeURIComponent(projectId)}`,
  );
  if (!response.ok) return null;

  const payload: unknown = await response.json();
  const parsed = docsResolutionResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.site : null;
}

async function readManifest(
  env: RuntimeSourceEnv,
  path: string,
  runtimeContext: RuntimeRequestContext,
): Promise<DocsManifestReadResult> {
  const manifestPath = safeRelativePath(path);
  return readCached(
    runtimeContext.cache.manifests,
    runtimeModuleCaches.manifests,
    `manifest:${manifestPath}`,
    async () => {
      const raw = await readText(env, manifestPath, runtimeContext);
      if (!raw) return { status: "missing" };
      return interpretManifestText(manifestPath, raw);
    },
    runtimeContext.timing,
    { cacheKind: "manifest", artifactKind: "manifest" },
  );
}

function interpretManifestText(
  manifestPath: string,
  raw: string,
): DocsManifestReadResult {
  const parsed = parseDocsManifestText(raw);
  if (parsed.ok) return { status: "ok", manifest: parsed.manifest };
  if (parsed.reason !== "unsupported_schema_version") {
    return { status: "unreadable" };
  }

  // A writer newer than this renderer is a deploy-order bug, not a content
  // problem. Log it so the mismatch is visible in the Worker logs.
  console.error(
    JSON.stringify({
      event: "docs_artifact_schema_unsupported",
      manifestPath,
      schemaVersion: parsed.schemaVersion,
      supportedSchemaVersions: SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS,
    }),
  );
  return { status: "unsupported_schema", schemaVersion: parsed.schemaVersion };
}

async function runRuntimeOperation(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  request: RuntimeRequest,
  runtimeContext: RuntimeRequestContext,
): Promise<unknown> {
  switch (request.operation) {
    case "getResolvedSiteConfig":
      return readSiteConfig(env, context, runtimeContext);
    case "getSiteConfig":
      return getSiteConfig(env, context, runtimeContext);
    case "getCompanyConfig": {
      // Deprecated: use getResolvedSiteConfig.
      const config = await readSiteConfig(env, context, runtimeContext);
      return { name: config.name, link: config.branding.logo.href };
    }
    case "getSocialConfig": {
      // Deprecated: use getResolvedSiteConfig.
      const config = await readSiteConfig(env, context, runtimeContext);
      const title = config.name;
      const description = config.description;
      const images = config.branding.ogImage
        ? [{ url: assetUrl(config.branding.ogImage), alt: title }]
        : [];
      return {
        twitterHandle: config.seo.twitterHandle,
        openGraph: {
          type: "website",
          title,
          description,
          siteName: title,
          images,
        },
        twitter: {
          card: images.length ? "summary_large_image" : "summary",
          title,
          description,
          site: config.seo.twitterHandle,
          images,
        },
      };
    }
    case "getThemeConfig": {
      // Deprecated: use getResolvedSiteConfig.
      const config = await readSiteConfig(env, context, runtimeContext);
      return {
        primaryColor: config.theme.primary ?? "default",
        activeTheme: config.theme.preset,
      };
    }
    case "getFeatureConfig":
      return getFeatureConfig(env, context, runtimeContext);
    case "getSections":
      return readSections(env, context, runtimeContext);
    case "getNavigation":
      return readNavigation(
        env,
        context,
        getSectionSlug(request.payload),
        runtimeContext,
      );
    case "getRoutes": {
      return readRoutes(
        env,
        context,
        getSectionSlug(request.payload),
        runtimeContext,
      );
    }
    case "getHomeHref":
      return getHomeHref(env, context, runtimeContext);
    case "getRouteData":
      return getRouteData(
        env,
        context,
        getPathname(request.payload),
        runtimeContext,
      );
    case "resolvePage":
      return resolvePage(
        env,
        context,
        getPathname(request.payload),
        runtimeContext,
      );
    case "getPage":
      return getPage(env, context, getSlug(request.payload), runtimeContext);
    case "getRawPage":
      return getRawPage(env, context, getSlug(request.payload), runtimeContext);
    case "getSearchIndex":
      return readText(
        env,
        safeArtifactPath(context.artifactPrefix, "search/index.json"),
        runtimeContext,
      );
    case "getCompiledSearchIndex":
      return readText(
        env,
        safeArtifactPath(context.artifactPrefix, "search/minisearch.json"),
        runtimeContext,
      );
    case "getPrerenderPlan":
      return getPrerenderPlan(env, context, runtimeContext);
  }
}

type PrerenderPlanEntry =
  | { kind: "page"; pathname: string }
  | {
      kind: "live_only";
      pathname: string;
      reason: "unsupported_route";
    }
  | {
      kind: "redirect";
      pathname: string;
      target: string;
      status: 308;
    };

async function getPrerenderPlan(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  runtimeContext: RuntimeRequestContext,
): Promise<PrerenderPlanEntry[]> {
  const pagePaths = new Set(
    context.manifest.pages.map((page) => normalizeHref(page.href)),
  );
  const entries: PrerenderPlanEntry[] = [...pagePaths].map((pathname) => ({
    kind: "page",
    pathname,
  }));
  const homeHref = await getHomeHref(env, context, runtimeContext);
  if (homeHref && pagePaths.has(homeHref) && !pagePaths.has("/")) {
    entries.push({
      kind: "page",
      pathname: "/",
    });
  } else if (pagePaths.size === 0) {
    entries.push({
      kind: "live_only",
      pathname: "/",
      reason: "unsupported_route",
    });
  }

  const sections = await readSections(env, context, runtimeContext);
  for (const section of sections) {
    if (section.default || section.hidden) continue;
    const target = await getSectionRedirectTarget(
      env,
      context,
      section,
      runtimeContext,
    );
    if (target && pagePaths.has(target)) {
      entries.push({
        kind: "redirect",
        pathname: getSectionPath(section),
        target,
        status: 308,
      });
    }
  }

  const uniqueEntries = new Map<string, PrerenderPlanEntry>();
  for (const entry of entries) {
    const current = uniqueEntries.get(entry.pathname);
    if (current && current.kind !== entry.kind) {
      throw new Error(`Conflicting pre-render route: ${entry.pathname}`);
    }
    uniqueEntries.set(entry.pathname, entry);
  }
  if (uniqueEntries.size > 2_000) {
    throw new Error("The pre-render plan exceeds the route limit.");
  }
  return [...uniqueEntries.values()].sort((left, right) =>
    left.pathname.localeCompare(right.pathname),
  );
}

async function getRouteData(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  pathname: string,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeRouteData> {
  // Start the reads that do not depend on the page now, so that cold R2 reads
  // overlap. The request cache gives the later awaits the same promises.
  const sectionsRead = readSections(env, context, runtimeContext);
  const siteConfigRead = readSiteConfig(env, context, runtimeContext);
  const homeHrefRead = getHomeHref(env, context, runtimeContext);
  const sectionHomeHrefsRead = sectionsRead.then((sections) =>
    getSectionHomeHrefs(env, context, sections, runtimeContext),
  );
  // A redirect or a not-found page returns before these reads are awaited.
  for (const read of [
    sectionsRead,
    siteConfigRead,
    homeHrefRead,
    sectionHomeHrefsRead,
  ]) {
    read.catch(() => undefined);
  }

  const resolution = await resolvePage(env, context, pathname, runtimeContext);

  if (resolution.type === "redirect") {
    return {
      type: "redirect",
      href: normalizeHref(resolution.href),
      status: resolution.status,
    };
  }

  if (
    resolution.type === "not_found" &&
    isDefaultPrefixedSlug(resolution.slug)
  ) {
    return {
      type: "router_not_found",
      href: resolution.href,
      slug: resolution.slug,
    };
  }

  const sections = await sectionsRead;
  const href = normalizeHref(resolution.href);
  const slug =
    resolution.type === "page" ? resolution.slug : normalizeSlug(href);
  const currentSection = getSectionFromHref(sections, href);
  const sectionSlug = currentSection?.slug ?? "";
  const [
    rawSectionNavigation,
    sectionRoutes,
    homeHref,
    sectionHomeHrefs,
    siteConfig,
    site,
    features,
  ] = await Promise.all([
    sectionSlug
      ? readNavigation(env, context, sectionSlug, runtimeContext)
      : Promise.resolve([]),
    sectionSlug
      ? readRoutes(env, context, sectionSlug, runtimeContext)
      : Promise.resolve([]),
    homeHrefRead,
    sectionHomeHrefsRead,
    siteConfigRead,
    getSiteConfig(env, context, runtimeContext),
    getFeatureConfig(env, context, runtimeContext),
  ]);
  const sectionNavigation = flattenNavigation(rawSectionNavigation);
  const routeTitle =
    sectionRoutes.find((route) => normalizeHref(route.href) === href)?.title ??
    null;
  const sectionHeading = findSectionHeading(sectionNavigation, href) ?? null;
  const { previous, next } = getPreviousNext(sectionRoutes, href);

  return {
    type: resolution.type === "page" ? "page" : "not_found",
    slug,
    href,
    homeHref,
    siteConfig,
    site,
    features,
    sections,
    currentSection,
    sectionHomeHrefs,
    sectionNavigation,
    sectionRoutes,
    routeTitle,
    sectionHeading,
    previous,
    next,
    page: resolution.type === "page" ? resolution.page : null,
  };
}

async function getSiteConfig(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeSiteConfig> {
  const config = await readSiteConfig(env, context, runtimeContext);
  return {
    name: config.name,
    description: config.description,
    url: getSiteUrl(env, context),
  };
}

/**
 * The origin of canonical links. Each hostname of a site links to itself; the
 * environment value is only for calls without a resolved hostname, such as
 * local development.
 */
function getSiteUrl(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
): string {
  return (context.siteUrl ?? env.DOCS_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
}

async function getFeatureConfig(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeFeatureConfig> {
  return runtimeFeatures(await readSiteConfig(env, context, runtimeContext));
}

async function resolvePage(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  pathname: string,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimePageResolution> {
  const href = normalizeHref(pathname);
  const slug = normalizeSlug(href);

  if (href === "/") {
    const homeHref = await getHomeHref(env, context, runtimeContext);
    if (homeHref && homeHref !== "/") {
      const homePage = await getPage(env, context, homeHref, runtimeContext);
      if (homePage) {
        return {
          type: "page",
          href: homePage.href,
          slug: homePage.slug,
          page: homePage,
        };
      }
    }
  }

  const sections = await readSections(env, context, runtimeContext);
  const matchedSection = sections.find(
    (section) => !section.default && section.slug === slug,
  );
  if (matchedSection) {
    const target = await getSectionRedirectTarget(
      env,
      context,
      matchedSection,
      runtimeContext,
    );
    if (target) return { type: "redirect", href: target, status: 308 };
  }

  const page = await getPage(env, context, href, runtimeContext);
  if (page) return { type: "page", href: page.href, slug: page.slug, page };

  return { type: "not_found", href, slug };
}

async function getPage(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  slugOrHref: string,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimePage | null> {
  const raw = await getRawPage(env, context, slugOrHref, runtimeContext);
  if (!raw) return null;

  const [sections, assets] = await Promise.all([
    readSections(env, context, runtimeContext),
    readPageAssetVersions(
      runtimeContext.artifacts,
      context.artifactPrefix,
      raw.body,
    ),
  ]);
  return {
    ...raw,
    keywords: parseFrontmatter(raw.body).keywords,
    sectionSlug: getSectionSlugForHref(sections, raw.href),
    headings: extractHeadings(raw.body),
    ...(assets ? { assets } : {}),
  };
}

async function getRawPage(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  slugOrHref: string,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeRawPage | null> {
  const href = normalizeHref(slugOrHref);
  const manifestPage = context.manifest.pages.find(
    (page) => normalizeHref(page.href) === href,
  );
  if (!manifestPage) return null;

  const sourcePath = safeRelativePath(manifestPage.sourcePath);
  const body = await readText(
    env,
    safeArtifactPath(context.artifactPrefix, sourcePath),
    runtimeContext,
  );
  if (!body) return null;

  const frontmatter = parseFrontmatter(body);
  return {
    slug: normalizeSlug(href),
    href,
    title: frontmatter.title || manifestPage.title,
    description: frontmatter.description,
    apiMethod: frontmatter.apiMethod,
    apiPath: frontmatter.apiPath,
    sourcePath,
    body,
  };
}

async function readSections(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeSection[]> {
  const cacheKey = `sections:${safeRelativePath(context.artifactPrefix)}`;
  return readCached(
    runtimeContext.cache.sections,
    runtimeModuleCaches.sections,
    cacheKey,
    async () => {
      const raw = await readText(
        env,
        safeArtifactPath(context.artifactPrefix, "settings/sections.json"),
        runtimeContext,
      );
      if (!raw) return [DEFAULT_SECTION];

      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [DEFAULT_SECTION];

        const sections = parsed
          .filter(isRuntimeSection)
          .map((section, index) => ({
            ...section,
            default:
              section.default === true ||
              (section.slug === DEFAULT_SECTION.slug && index === 0),
          }));
        return sections.length > 0 ? sections : [DEFAULT_SECTION];
      } catch {
        return [DEFAULT_SECTION];
      }
    },
    runtimeContext.timing,
    { cacheKind: "sections", artifactKind: "sections" },
  );
}

async function readNavigation(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  sectionSlug: string,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeNavNode[]> {
  const normalizedSectionSlug = safeRelativePath(sectionSlug);
  const cacheKey = `navigation:${safeRelativePath(context.artifactPrefix)}:${normalizedSectionSlug}`;
  return readCached(
    runtimeContext.cache.navigation,
    runtimeModuleCaches.navigation,
    cacheKey,
    async () => {
      const fileName =
        normalizedSectionSlug === DEFAULT_SECTION.slug
          ? "settings/documents.json"
          : `settings/documents.${normalizedSectionSlug}.json`;
      const raw = await readText(
        env,
        safeArtifactPath(context.artifactPrefix, fileName),
        runtimeContext,
      );
      if (!raw) {
        return context.manifest.pages.map((page) => ({
          title: page.title,
          href: normalizeHref(page.href),
        }));
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isRuntimeNavNode).map(normalizeNavNode);
      } catch {
        return [];
      }
    },
    runtimeContext.timing,
    { cacheKind: "navigation", artifactKind: "navigation" },
  );
}

async function readRoutes(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  sectionSlug: string,
  runtimeContext: RuntimeRequestContext,
): Promise<RuntimeNavPage[]> {
  const normalizedSectionSlug = safeRelativePath(sectionSlug);
  const cacheKey = `routes:${safeRelativePath(context.artifactPrefix)}:${normalizedSectionSlug}`;
  return readCached(
    runtimeContext.cache.routes,
    runtimeModuleCaches.routes,
    cacheKey,
    async () =>
      flattenRoutes(
        await readNavigation(
          env,
          context,
          normalizedSectionSlug,
          runtimeContext,
        ),
      ),
    runtimeContext.timing,
    { cacheKind: "routes", artifactKind: "navigation" },
  );
}

export async function readText(
  env: RuntimeSourceEnv,
  path: string,
  runtimeContext: RuntimeRequestContext,
): Promise<string | null> {
  const artifactPath = safeRelativePath(path);
  const artifactKind = getArtifactKind(artifactPath);
  return readCached(
    runtimeContext.cache.artifacts,
    runtimeModuleCaches.artifacts,
    `artifact:${artifactPath}`,
    () => readTextUncached(env, artifactPath, runtimeContext),
    runtimeContext.timing,
    { cacheKind: "artifact", artifactKind },
  );
}

async function readTextUncached(
  env: RuntimeSourceEnv,
  path: string,
  runtimeContext: RuntimeRequestContext,
): Promise<string | null> {
  const { timing } = runtimeContext;
  const artifactKind = getArtifactKind(path);
  const bucketStartedAt = now();
  const object = await runtimeContext.artifacts.get(path);
  const bucketMs = elapsed(bucketStartedAt);
  recordArtifactRead(runtimeContext, bucketMs);
  timing.mark("artifact.bucketGet", {
    artifactKind,
    hit: Boolean(object),
    durationMs: bucketMs,
  });
  if (object) {
    const textStartedAt = now();
    const text = await object.text();
    timing.mark("artifact.text", {
      artifactKind,
      source: "r2",
      durationMs: elapsed(textStartedAt),
      bytes: text.length,
    });
    return text;
  }

  if (env.API) {
    try {
      const rpcStartedAt = now();
      const rpcArtifact = await env.API.readDocsArtifact(path);
      timing.mark("artifact.rpc", {
        artifactKind,
        hit: Boolean(rpcArtifact?.text),
        durationMs: elapsed(rpcStartedAt),
        bytes: rpcArtifact?.text?.length ?? 0,
      });
      return rpcArtifact?.text ?? null;
    } catch {
      if (!isInternalHttpFallbackAllowed(env)) return null;
    }
  }

  if (!isInternalHttpFallbackAllowed(env)) return null;

  const httpStartedAt = now();
  const response = await fetchFromApiBaseUrl(
    env,
    `/internal/docs-artifacts?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) {
    timing.mark("artifact.http", {
      artifactKind,
      hit: false,
      status: response.status,
      durationMs: elapsed(httpStartedAt),
    });
    return null;
  }

  const text = await response.text();
  timing.mark("artifact.http", {
    artifactKind,
    hit: true,
    status: response.status,
    durationMs: elapsed(httpStartedAt),
    bytes: text.length,
  });
  return text;
}

function readCached<T>(
  requestCache: Map<string, Promise<T>>,
  moduleCache: Map<string, RuntimeCacheEntry<T>>,
  key: string,
  loader: () => Promise<T>,
  timing: RuntimeTiming,
  data: RuntimeTimingData = {},
): Promise<T> {
  const requestCached = requestCache.get(key);
  if (requestCached) {
    timing.mark("cache.hit", { ...data, cacheScope: "request" });
    return requestCached;
  }

  const moduleCached = moduleCache.get(key);
  if (moduleCached && moduleCached.expiresAt > now()) {
    timing.mark("cache.hit", { ...data, cacheScope: "module" });
    requestCache.set(key, moduleCached.value);
    return moduleCached.value;
  }
  if (moduleCached) moduleCache.delete(key);

  const value = loader().catch((error: unknown) => {
    requestCache.delete(key);
    moduleCache.delete(key);
    throw error;
  });
  requestCache.set(key, value);
  moduleCache.set(key, {
    value,
    expiresAt: now() + RUNTIME_CACHE_TTL_MS,
  });
  pruneRuntimeCache(moduleCache);
  return value;
}

function readRequestCached<T>(
  requestCache: Map<string, Promise<T>>,
  key: string,
  loader: () => Promise<T>,
  timing: RuntimeTiming,
  data: RuntimeTimingData = {},
): Promise<T> {
  const cached = requestCache.get(key);
  if (cached) {
    timing.mark("cache.hit", { ...data, cacheScope: "request" });
    return cached;
  }

  const value = loader().catch((error: unknown) => {
    requestCache.delete(key);
    throw error;
  });
  requestCache.set(key, value);
  return value;
}

function pruneRuntimeCache<T>(cache: Map<string, RuntimeCacheEntry<T>>): void {
  while (cache.size > RUNTIME_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function fetchFromApiBaseUrl(
  env: RuntimeSourceEnv,
  path: string,
): Promise<Response> {
  const baseUrl = env.API_BASE_URL ?? "http://localhost:8787";
  return fetch(`${baseUrl.replace(/\/+$/, "")}${path}`);
}

function createRuntimeTiming(env: RuntimeSourceEnv): RuntimeTiming {
  const enabled = isTruthyFlag(env.DOXA_DOCS_RUNTIME_TIMING);

  return {
    enabled,
    mark(event, data = {}) {
      if (!enabled) return;
      console.info(
        "[doxa-docs-runtime:timing]",
        JSON.stringify({
          event,
          ...data,
        }),
      );
    },
    async measure(event, operation, data = {}) {
      if (!enabled) return operation();

      const startedAt = now();
      try {
        const result = await operation();
        this.mark(event, {
          ...data,
          ok: true,
          durationMs: elapsed(startedAt),
        });
        return result;
      } catch (error) {
        this.mark(event, {
          ...data,
          ok: false,
          durationMs: elapsed(startedAt),
          errorName:
            error instanceof Error ? error.name || "Error" : "UnknownError",
        });
        throw error;
      }
    },
  };
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function now(): number {
  return Date.now();
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function estimateJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function getArtifactKind(path: string): string {
  if (path.endsWith("/manifest.json")) return "manifest";
  if (path.includes("/settings/sections.json")) return "sections";
  if (path.includes("/settings/documents")) return "navigation";
  if (path.includes("/search/")) return "search";
  if (path.includes("/source/")) return "source";
  return "other";
}

function isInternalHttpFallbackAllowed(env: RuntimeSourceEnv): boolean {
  return env.ALLOW_INTERNAL_HTTP === "true";
}

function getSectionSlug(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const sectionSlug = (payload as { sectionSlug?: unknown }).sectionSlug;
    if (typeof sectionSlug === "string" && sectionSlug.trim())
      return sectionSlug.trim();
  }

  return DEFAULT_SECTION.slug;
}

function getPathname(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const pathname = (payload as { pathname?: unknown }).pathname;
    if (typeof pathname === "string") return pathname;
  }

  return "/";
}

function getSlug(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const slug = (payload as { slug?: unknown }).slug;
    if (typeof slug === "string") return slug;
  }

  return typeof payload === "string" ? payload : "/";
}

async function getHomeHref(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  runtimeContext: RuntimeRequestContext,
): Promise<string | null> {
  const [config, routes] = await Promise.all([
    readSiteConfig(env, context, runtimeContext),
    readRoutes(env, context, DEFAULT_SECTION.slug, runtimeContext),
  ]);
  const pagePaths = new Set(
    context.manifest.pages.map((page) => normalizeHref(page.href)),
  );
  return resolveHomeHref(
    config,
    (href) => pagePaths.has(href),
    routes[0]?.href ?? null,
  );
}

/**
 * Where the URL of a section sends a visitor: its first page. A page stored
 * at the section path wins, so a section never hides it. Live routing and the
 * pre-render plan both use this, so they always agree.
 */
async function getSectionRedirectTarget(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  section: RuntimeSection,
  runtimeContext: RuntimeRequestContext,
): Promise<string | null> {
  const sectionPath = getSectionPath(section);
  if (hasManifestPage(context, sectionPath)) return null;
  const firstRoute = (
    await readRoutes(env, context, section.slug, runtimeContext)
  )[0];
  if (!firstRoute) return null;
  const target = normalizeHref(firstRoute.href);
  return target === sectionPath ? null : target;
}

function getSectionPath(section: RuntimeSection): string {
  return normalizeHref(`/${section.slug}`);
}

function hasManifestPage(context: ProjectRuntimeContext, href: string): boolean {
  return context.manifest.pages.some((page) => normalizeHref(page.href) === href);
}

async function getSectionHomeHrefs(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  sections: RuntimeSection[],
  runtimeContext: RuntimeRequestContext,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    sections
      .filter((section) => !section.hidden)
      .map(async (section) => {
        const href = (
          await readRoutes(env, context, section.slug, runtimeContext)
        )[0]?.href;
        return href ? ([section.slug, normalizeHref(href)] as const) : null;
      }),
  );

  return Object.fromEntries(entries.filter(isSectionHomeHrefEntry));
}

function isSectionHomeHrefEntry(
  entry: readonly [string, string] | null,
): entry is readonly [string, string] {
  return entry !== null;
}

function getSectionFromHref(
  sections: RuntimeSection[],
  href: string,
): RuntimeSection | null {
  const normalizedHref = normalizeHref(href);
  const firstSegment = normalizedHref.split("/").filter(Boolean)[0];
  const prefixedSection = sections.find(
    (section) => !section.default && section.slug === firstSegment,
  );

  return prefixedSection ?? sections.find((section) => section.default) ?? null;
}

function flattenNavigation(
  nodes: RuntimeNavNode[],
  parentHref = "",
): RuntimeNavNode[] {
  const flattened: RuntimeNavNode[] = [];

  for (const node of nodes) {
    if (isRuntimeNavPage(node)) {
      const href = joinHrefs(parentHref, node.href);
      const { items, ...page } = node;
      flattened.push({ ...page, href });
      if (node.items) flattened.push(...flattenNavigation(node.items, href));
    } else {
      flattened.push(node);
    }
  }

  return flattened;
}

function findSectionHeading(
  navigation: RuntimeNavNode[],
  href: string,
): string | undefined {
  const targetHref = normalizeHref(href);
  let currentHeading: string | undefined;

  for (const node of navigation) {
    if (isRuntimeNavHeading(node)) {
      currentHeading = node.heading;
    } else if (
      isRuntimeNavPage(node) &&
      normalizeHref(node.href) === targetHref
    ) {
      return currentHeading;
    }
  }

  return undefined;
}

function getPreviousNext(
  routes: RuntimeNavPage[],
  href: string,
): { previous: RuntimeNavPage | null; next: RuntimeNavPage | null } {
  const targetHref = normalizeHref(href);
  const index = routes.findIndex(
    (route) => normalizeHref(route.href) === targetHref,
  );

  if (index === -1) {
    return { previous: null, next: null };
  }

  return {
    previous: index > 0 ? routes[index - 1] : null,
    next: index < routes.length - 1 ? routes[index + 1] : null,
  };
}

function flattenRoutes(
  nodes: RuntimeNavNode[],
  parentHref = "",
): RuntimeNavPage[] {
  const pages: RuntimeNavPage[] = [];

  for (const node of nodes) {
    if (isRuntimeNavPage(node)) {
      const href = joinHrefs(parentHref, node.href);
      if (!node.noLink) {
        const { items: _items, ...page } = node;
        pages.push({ ...page, href });
      }
      if (node.items) pages.push(...flattenRoutes(node.items, href));
    }
  }

  return pages;
}

function isDefaultPrefixedSlug(slug: string): boolean {
  return slug === "default" || slug.startsWith("default/");
}

function normalizeNavNode(node: RuntimeNavNode): RuntimeNavNode {
  if (isRuntimeNavPage(node)) {
    return {
      ...node,
      href: normalizeHref(node.href),
      ...(node.items ? { items: node.items.map(normalizeNavNode) } : {}),
    };
  }

  return node;
}

function isRuntimeSection(value: unknown): value is RuntimeSection {
  if (!value || typeof value !== "object") return false;
  const section = value as Record<string, unknown>;
  return typeof section.slug === "string" && typeof section.label === "string";
}

function isRuntimeNavNode(value: unknown): value is RuntimeNavNode {
  return (
    isRuntimeNavPage(value) ||
    isRuntimeNavHeading(value) ||
    isRuntimeNavSpacer(value)
  );
}

function isRuntimeNavPage(value: unknown): value is RuntimeNavPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return typeof page.title === "string" && typeof page.href === "string";
}

function isRuntimeNavHeading(value: unknown): value is RuntimeNavHeading {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { heading?: unknown }).heading === "string",
  );
}

function isRuntimeNavSpacer(value: unknown): value is RuntimeNavSpacer {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { spacer?: unknown }).spacer === true,
  );
}

function getSectionSlugForHref(
  sections: RuntimeSection[],
  href: string,
): string {
  const normalizedHref = normalizeHref(href);
  const firstSegment = normalizedHref.split("/").filter(Boolean)[0];
  const prefixedSection = sections.find(
    (section) => !section.default && section.slug === firstSegment,
  );
  return (
    prefixedSection?.slug ??
    sections.find((section) => section.default)?.slug ??
    DEFAULT_SECTION.slug
  );
}

function parseFrontmatter(source: string): Frontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---\s*/.exec(source);
  if (!match) return { title: "", description: "", keywords: [] };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    data[key] = value;
  }

  return {
    title: data.title ?? "",
    description: data.description ?? "",
    keywords:
      data.keywords
        ?.split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean) ?? [],
    apiMethod: normalizeApiMethod(data.apiMethod),
    apiPath: data.apiPath || undefined,
  };
}

function normalizeApiMethod(value: string | undefined): string | undefined {
  switch (value?.toUpperCase()) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return value.toUpperCase();
    default:
      return undefined;
  }
}

function extractHeadings(source: string): RuntimePage["headings"] {
  const body = source.replace(/^---\s*\n[\s\S]*?\n---\s*/, "");
  return body
    .split(/\r?\n/)
    .map((line) => /^(#{2,6})\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      level: match[1].length,
      text: match[2].trim(),
      href: `#${innerSlug(match[2])}`,
    }));
}

function joinHrefs(parentHref: string, href: string): string {
  const parent = normalizeHref(parentHref);
  const child = normalizeHref(href);
  if (parent === "/") return child;
  if (child === "/") return parent;
  return normalizeHref(`${parent}/${child}`);
}

function normalizeHref(value: string): string {
  const clean = value
    .trim()
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/(?:^|\/)index(?:\.mdx?)?$/i, "");

  const normalized = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `/${normalized}` : "/";
}

function normalizeSlug(value: string): string {
  const href = normalizeHref(value);
  return href === "/" ? "" : href.slice(1);
}

function safeArtifactPath(prefix: string, relativePath: string): string {
  return `${safeRelativePath(prefix)}/${safeRelativePath(relativePath)}`;
}

function safeRelativePath(path: string): string {
  const clean = path.trim().replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.includes("\\")) {
    throw new Error(`Unsafe artifact path: ${path}`);
  }
  return clean;
}

function innerSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5\-_]/g, "");
}

async function timingSafeEqual(
  candidate: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const candidateBytes = encoder.encode(candidate);
  const expectedBytes = encoder.encode(expected);
  const maxLength = Math.max(candidateBytes.length, expectedBytes.length);
  let diff = candidateBytes.length ^ expectedBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (candidateBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  await crypto.subtle.digest("SHA-256", expectedBytes);
  return diff === 0;
}

function json(body: RuntimeResponseBody, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      vary: "authorization, x-doxa-host, x-doxa-project-id",
    },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return json({ ok: false, error: { code, message } }, status);
}
