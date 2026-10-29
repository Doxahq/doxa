import { z } from "zod";

/**
 * Warm state: which upper-tier cache pools already hold a site's pages for
 * the deployed renderer release. The regional warm job writes it through the
 * site's warm lock (one writer per site); the docs dispatcher only reads it,
 * inside the build window after a renderer deploy, to decide whether a
 * visitor's pool is warm or should get the previous build's cached output.
 * See docs/current/production-docs-caching.md, "Previous-build fallback".
 */

/**
 * The regional upper-tier pools of Workers Cache, measured by spike S1.
 * A fill in one pool serves every data center of that pool and no other.
 */
export const WARM_POOLS = [
  "us-west",
  "us-east",
  "eu-west",
  "eu-east",
  "asia-ne",
  "hong-kong",
  "singapore",
  "oceania",
] as const;

export const warmPoolSchema = z.enum(WARM_POOLS);

export type WarmPool = z.infer<typeof warmPoolSchema>;

/** Increase when the stored record changes shape; readers treat others as cold. */
export const DOCS_WARM_STATE_FORMAT = 1;

const releaseIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const docsWarmStateSchema = z
  .object({
    format: z.literal(DOCS_WARM_STATE_FORMAT),
    /** The renderer release that the pools below finished warming. */
    releaseId: releaseIdSchema,
    /** When each pool finished this release (epoch ms). A missing pool is cold. */
    pools: z.partialRecord(warmPoolSchema, z.number().int().nonnegative()),
  })
  .strict();

export type DocsWarmState = z.infer<typeof docsWarmStateSchema>;

/** The key of a site's warm state, in the `DOCS_HOSTNAME_MAP` namespace. */
export function docsWarmStateKey(siteId: string): string {
  return `warm:${siteId}`;
}

/** Any value that is not a valid record of the current format reads as null. */
export function parseDocsWarmState(value: unknown): DocsWarmState | null {
  const parsed = docsWarmStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** True when `pool` finished warming `releaseId`. */
export function isWarmPoolDone(
  state: DocsWarmState,
  releaseId: string,
  pool: WarmPool,
): boolean {
  return state.releaseId === releaseId && state.pools[pool] !== undefined;
}
