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

export async function loadRendererCodePackage(input: {
  bucket: R2Bucket;
  objectKey: string;
  expectedBuildId: string;
}): Promise<RendererCodePackage> {
  const cacheKey = `${input.objectKey}:${input.expectedBuildId}`;
  const existing = rendererPackageCache.get(cacheKey);
  if (existing) return existing;

  const pending = readRendererCodePackage(input).catch((error) => {
    rendererPackageCache.delete(cacheKey);
    throw error;
  });
  rendererPackageCache.set(cacheKey, pending);
  trimPackageCache();
  return pending;
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

async function readRendererCodePackage(input: {
  bucket: R2Bucket;
  objectKey: string;
  expectedBuildId: string;
}): Promise<RendererCodePackage> {
  const object = await input.bucket.get(input.objectKey);
  if (!object) {
    throw new Error(`Renderer code package not found: ${input.objectKey}`);
  }

  const decoded = object.body.pipeThrough(new DecompressionStream("gzip"));
  const raw = await new Response(decoded).text();
  return parseRendererCodePackage(raw, input.expectedBuildId);
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
