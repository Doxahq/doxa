/**
 * R2 lifecycle rules of the docs bucket.
 *
 * Two systems delete derived storage. A storage GC collector (see
 * `./storage-gc.ts`) owns data that a row can point to. An R2 lifecycle rule
 * owns data that nothing points to and that is safe to lose: scratch files and
 * caches. Every prefix has exactly one owner.
 *
 * A rule names one dedicated prefix, never the bucket root, because the docs
 * artifacts share the bucket. The rules are applied by hand with Wrangler; see
 * `docs/current/storage-garbage-collection.md`, section "R2 Lifecycle Rules".
 */

export const DOCS_ARTIFACTS_BUCKET = "doxa-docs-artifacts-enam" as const;

/** Run checkpoints: `_generation-checkpoints/{jobId}/…`. */
export const GENERATION_CHECKPOINT_PREFIX = "_generation-checkpoints/" as const;
/** Failed MDX drafts of repair diagnostics: `_generation-diagnostics/{jobId}/…`. */
export const GENERATION_DIAGNOSTIC_PREFIX = "_generation-diagnostics/" as const;
/** Content-addressed written pages. */
export const PAGE_CACHE_PREFIX = "cache/pages/" as const;
/** Content-addressed generation plans. */
export const PLAN_CACHE_PREFIX = "cache/plans/" as const;

/**
 * Days after upload before R2 deletes a scratch or cache object.
 *
 * - Checkpoints: the last Workflow step deletes them after a success. A
 *   failed or cancelled run leaves them, and nothing resumes it after 30 days.
 * - Diagnostics: the same 30 days as their `generation_repair_diagnostics` row.
 * - Caches: an expired entry is only a cache miss.
 */
export const R2_LIFECYCLE_RETENTION_DAYS = {
  generationCheckpoints: 30,
  generationDiagnostics: 30,
  pageCache: 30,
  planCache: 30,
} as const;

/**
 * R2 counts the age of an object from its upload. A cache read rewrites an
 * entry older than this, so a hot entry never reaches its expiry.
 */
export const R2_CACHE_REFRESH_AFTER_DAYS = 20;

export interface R2LifecycleRule {
  /** The Wrangler rule id. It never changes after the rule is installed. */
  readonly id: string;
  /** One dedicated prefix that ends with `/`. Never the bucket root. */
  readonly prefix: string;
  readonly expireDays: number;
}

export const R2_LIFECYCLE_RULES = [
  {
    id: "doxa-generation-checkpoints-expiry",
    prefix: GENERATION_CHECKPOINT_PREFIX,
    expireDays: R2_LIFECYCLE_RETENTION_DAYS.generationCheckpoints,
  },
  {
    id: "doxa-generation-diagnostics-expiry",
    prefix: GENERATION_DIAGNOSTIC_PREFIX,
    expireDays: R2_LIFECYCLE_RETENTION_DAYS.generationDiagnostics,
  },
  {
    // Installed on 2026-07-30. Keep the id.
    id: "doxa-page-cache-expiry",
    prefix: PAGE_CACHE_PREFIX,
    expireDays: R2_LIFECYCLE_RETENTION_DAYS.pageCache,
  },
  {
    id: "doxa-plan-cache-expiry",
    prefix: PLAN_CACHE_PREFIX,
    expireDays: R2_LIFECYCLE_RETENTION_DAYS.planCache,
  },
] as const satisfies readonly R2LifecycleRule[];

/** The Wrangler command that installs one rule. Doxa never runs it. */
export function r2LifecycleAddCommand(
  rule: R2LifecycleRule,
  bucket: string = DOCS_ARTIFACTS_BUCKET,
): string {
  return [
    "npx wrangler r2 bucket lifecycle add",
    bucket,
    rule.id,
    rule.prefix,
    `--expire-days ${rule.expireDays}`,
    "--force",
  ].join(" ");
}

/**
 * How long Cloudflare keeps the state of a finished generation Workflow
 * instance. An errored run stays longer for debugging. A terminated (cancelled)
 * run counts as a success.
 *
 * The agent worker sets this on each `create()` call. Wrangler can also set it
 * as `default_retention` on the binding, but the Wrangler version of this repo
 * drops that field with an "Unexpected fields" warning.
 */
export const GENERATION_WORKFLOW_RETENTION = {
  successRetention: "7 days",
  errorRetention: "30 days",
} as const;

/**
 * Prefixes that a storage GC collector owns. A lifecycle rule must not
 * overlap them, because a row can point to their objects.
 */
export const STORAGE_GC_OWNED_PREFIXES = ["sites/"] as const;
