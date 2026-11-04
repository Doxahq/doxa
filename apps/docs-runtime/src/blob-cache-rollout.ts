/** How far the tiered blob cache (`DocsBlobCache`) is rolled out. */
export type BlobCacheMode = "off" | "allowlist" | "all";

export interface BlobCacheRolloutEnv {
  DOXA_PROD_BLOB_CACHE_MODE?: string;
  /** Comma-separated site ids, read in `allowlist` mode. */
  DOXA_PROD_BLOB_CACHE_SITE_IDS?: string;
}

export interface BlobCacheRollout {
  mode: BlobCacheMode;
  siteIds: ReadonlySet<string>;
}

const warnedModes = new Set<string>();

/**
 * Reads the rollout. An unknown mode fails closed to `off` and logs one
 * warning per isolate.
 */
export function readBlobCacheRollout(
  env: BlobCacheRolloutEnv,
): BlobCacheRollout {
  const mode = parseBlobCacheMode(env.DOXA_PROD_BLOB_CACHE_MODE);
  return {
    mode,
    siteIds:
      mode === "allowlist"
        ? parseSiteIds(env.DOXA_PROD_BLOB_CACHE_SITE_IDS)
        : new Set(),
  };
}

export function usesBlobCache(
  rollout: BlobCacheRollout,
  siteId: string,
): boolean {
  return (
    rollout.mode === "all" ||
    (rollout.mode === "allowlist" && rollout.siteIds.has(siteId))
  );
}

function parseBlobCacheMode(value: string | undefined): BlobCacheMode {
  if (value === "allowlist" || value === "all") return value;
  if (value !== undefined && value !== "off") warnInvalidMode(value);
  return "off";
}

function parseSiteIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((siteId) => siteId.trim())
      .filter(Boolean),
  );
}

function warnInvalidMode(value: string): void {
  if (warnedModes.has(value)) return;
  warnedModes.add(value);
  console.warn(
    JSON.stringify({
      event: "docs_runtime_blob_cache_invalid_mode",
      value,
      fallback: "off",
    }),
  );
}
