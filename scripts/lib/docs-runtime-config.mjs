const RUNTIME_CONFIG = "apps/docs-runtime/wrangler.json";
const BLOB_CACHE_MODES = ["off", "allowlist", "all"];

/**
 * Workers Cache stays off for the docs runtime except for DocsBlobCache. A
 * cached default or RPC entrypoint would serve one site's response to
 * another caller.
 */
export function validateDocsRuntimeConfig(runtime) {
  if (
    runtime.cache?.enabled !== false ||
    runtime.cache?.cross_version_cache !== true
  ) {
    throw new Error(
      `${RUNTIME_CONFIG} must turn the Worker cache off and share entries across versions (cache.cross_version_cache).`,
    );
  }
  for (const entrypoint of ["default", "RuntimeSourceApi"]) {
    if (runtime.exports?.[entrypoint]?.cache?.enabled !== false) {
      throw new Error(
        `${RUNTIME_CONFIG} must not cache the ${entrypoint} entrypoint.`,
      );
    }
  }
  if (runtime.exports?.DocsBlobCache?.cache?.enabled !== true) {
    throw new Error(`${RUNTIME_CONFIG} must cache DocsBlobCache internally.`);
  }
  if (runtime.env?.production?.exports || runtime.env?.production?.cache) {
    throw new Error(
      `${RUNTIME_CONFIG} must keep its cache settings at the top level.`,
    );
  }
  // A typo would silently turn the cache off, so only the modes are accepted.
  if (
    !BLOB_CACHE_MODES.includes(
      runtime.env?.production?.vars?.DOXA_PROD_BLOB_CACHE_MODE,
    )
  ) {
    throw new Error(
      `${RUNTIME_CONFIG} must set DOXA_PROD_BLOB_CACHE_MODE to off, allowlist or all.`,
    );
  }
}
