/**
 * Core Agent Library - Prompt cache policy
 * Provider-neutral settings for prompt caching. A provider runtime that can
 * cache prompts turns this policy into its own request markers.
 */

/** How long a cached prompt prefix lives after its last read. */
export type PromptCacheTtl = "5m" | "1h";

export interface PromptCachePolicy {
  ttl: PromptCacheTtl;
}

/**
 * The one place that sets the cache lifetime. Switch to `"1h"` when runs
 * often pause longer than five minutes between calls with the same prefix.
 */
export const DEFAULT_PROMPT_CACHE_POLICY: PromptCachePolicy = { ttl: "5m" };

/**
 * `undefined` keeps the default policy. `false` turns caching off, for
 * example for a provider test that compares raw request bodies.
 */
export type PromptCacheSetting = PromptCachePolicy | false | undefined;

export function resolvePromptCachePolicy(
  setting: PromptCacheSetting,
): PromptCachePolicy | null {
  if (setting === false) return null;
  return setting ?? DEFAULT_PROMPT_CACHE_POLICY;
}
