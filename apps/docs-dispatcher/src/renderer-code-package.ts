const PACKAGE_SCHEMA_VERSION = 1;
const MAX_MODULE_COUNT = 500;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const rendererPackageCache = new Map<string, Promise<RendererCodePackage>>();

export interface RendererCodePackage {
  schemaVersion: 1;
  buildId: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: Record<string, string>;
}

/**
 * Where a cold renderer start got its code:
 * - `memory`: this dispatcher isolate had already loaded the package.
 * - `cache`: Workers Cache had the package bytes.
 * - `r2`: the bytes came from the R2 bucket, directly or by a cache fill.
 */
export type RendererCodeSource = "memory" | "cache" | "r2";

/** The gzip bytes of one renderer package, and where they came from. */
export interface RendererCodeBytes {
  body: ReadableStream;
  source: Exclude<RendererCodeSource, "memory">;
}

/** Reads the gzip bytes of the configured package. Never takes request input. */
export type RendererCodeReader = () => Promise<RendererCodeBytes>;

export interface LoadedRendererCode {
  code: RendererCodePackage;
  source: RendererCodeSource;
}

/**
 * Loads the package once per dispatcher isolate. The readers are tried in
 * order: when one fails, or its bytes fail the checks, the next one runs. The
 * build ID check applies to every reader.
 */
export async function loadRendererCodePackage(input: {
  objectKey: string;
  expectedBuildId: string;
  readers: readonly RendererCodeReader[];
  warn?: (message: string) => void;
}): Promise<LoadedRendererCode> {
  const cacheKey = `${input.objectKey}:${input.expectedBuildId}`;
  const existing = rendererPackageCache.get(cacheKey);
  if (existing) return { code: await existing, source: "memory" };

  const loaded = readFirstValidPackage(input);
  const pending = loaded.then(({ code }) => code);
  rendererPackageCache.set(cacheKey, pending);
  pending.catch(() => {
    if (rendererPackageCache.get(cacheKey) === pending) {
      rendererPackageCache.delete(cacheKey);
    }
  });
  trimPackageCache();
  return loaded;
}

/** Reads the package straight from the R2 bucket. */
export function createBucketCodeReader(
  bucket: R2Bucket,
  objectKey: string,
): RendererCodeReader {
  return async () => {
    const object = await bucket.get(objectKey);
    if (!object) {
      throw new Error(`Renderer code package not found: ${objectKey}`);
    }
    return { body: object.body, source: "r2" };
  };
}

async function readFirstValidPackage(input: {
  expectedBuildId: string;
  readers: readonly RendererCodeReader[];
  warn?: (message: string) => void;
}): Promise<LoadedRendererCode> {
  let lastError: unknown = new Error("No renderer code reader is configured.");
  for (const [index, read] of input.readers.entries()) {
    try {
      const bytes = await read();
      return {
        code: parseRendererCodePackage(
          await gunzipText(bytes.body),
          input.expectedBuildId,
        ),
        source: bytes.source,
      };
    } catch (error) {
      lastError = error;
      if (index < input.readers.length - 1) {
        input.warn?.(
          `[doxa-docs-dispatcher] Renderer code reader ${index} failed; trying the next one. ${describeError(error)}`,
        );
      }
    }
  }
  throw lastError;
}

function gunzipText(body: ReadableStream): Promise<string> {
  return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseRendererCodePackage(
  raw: string,
  expectedBuildId: string,
): RendererCodePackage {
  if (new TextEncoder().encode(raw).byteLength > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      "Renderer code package exceeds the uncompressed size limit.",
    );
  }

  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    throw new Error("Renderer code package has an unsupported schema version.");
  }
  if (value.buildId !== expectedBuildId) {
    throw new Error(
      "Renderer code package build ID does not match the deployment.",
    );
  }
  if (
    typeof value.compatibilityDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.compatibilityDate)
  ) {
    throw new Error("Renderer code package has an invalid compatibility date.");
  }
  if (!isStringArray(value.compatibilityFlags)) {
    throw new Error("Renderer code package has invalid compatibility flags.");
  }
  if (
    typeof value.mainModule !== "string" ||
    !isSafeModuleName(value.mainModule)
  ) {
    throw new Error("Renderer code package has an invalid main module.");
  }
  if (!isStringRecord(value.modules)) {
    throw new Error("Renderer code package contains invalid modules.");
  }

  const moduleNames = Object.keys(value.modules);
  if (moduleNames.length === 0 || moduleNames.length > MAX_MODULE_COUNT) {
    throw new Error("Renderer code package has an invalid module count.");
  }
  if (moduleNames.some((name) => !isSafeModuleName(name))) {
    throw new Error("Renderer code package contains an unsafe module name.");
  }
  if (!(value.mainModule in value.modules)) {
    throw new Error("Renderer code package main module is missing.");
  }

  return {
    schemaVersion: 1,
    buildId: expectedBuildId,
    compatibilityDate: value.compatibilityDate,
    compatibilityFlags: [...value.compatibilityFlags],
    mainModule: value.mainModule,
    modules: { ...value.modules },
  };
}

function trimPackageCache(): void {
  while (rendererPackageCache.size > 5) {
    const oldestKey = rendererPackageCache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    rendererPackageCache.delete(oldestKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isSafeModuleName(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split("/").includes("..") &&
    !value.includes("\\")
  );
}
