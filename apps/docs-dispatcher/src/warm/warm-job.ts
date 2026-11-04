import { docsDomainResolutionSchema } from "@doxahq/contracts";
import { docsWarmReasonSchema } from "@doxahq/contracts/docs-warm-job";
import { warmPoolSchema } from "@doxahq/contracts/docs-warm-state";
import { z } from "zod";

/**
 * The job that a regional warmer runs: one site, one pool, the hostnames as
 * the consumer read them from the hostname map, and the ordered pages. It
 * crosses Durable Object RPC and lives in warmer storage, so every reader
 * parses it with this schema.
 */
export const warmTargetSchema = z
  .object({
    hostname: z.string().min(1).max(253),
    resolution: docsDomainResolutionSchema,
    /** The hostname map entry's `resolvedAt` when the consumer read it. */
    resolvedAt: z.number().int().nonnegative(),
  })
  .strict();

export type WarmTarget = z.infer<typeof warmTargetSchema>;

export const warmJobSchema = z
  .object({
    jobId: z.string().uuid(),
    siteId: z.string().min(1).max(128),
    reason: docsWarmReasonSchema,
    releaseId: z.string().regex(/^[a-f0-9]{64}$/),
    pool: warmPoolSchema,
    targets: z.array(warmTargetSchema).min(1).max(10),
    /** Request pathnames, already ordered (M45) and capped (D9). */
    pages: z.array(z.string().min(1).max(2048)).max(2_000),
    startedAt: z.number().int().nonnegative(),
  })
  .strict();

export type WarmJob = z.infer<typeof warmJobSchema>;

/** What a warmer reports to the site lock when its job ends. */
export const warmOutcomeSchema = z.enum(["done", "failed", "superseded"]);

export type WarmOutcome = z.infer<typeof warmOutcomeSchema>;

/**
 * The identity of what a job warms: sorted hostnames, their live versions
 * and the renderer release. Two messages with the same target are the same
 * work; the lock keeps a done record per target for one hour.
 */
export async function createWarmTargetHash(
  targets: readonly Pick<WarmTarget, "hostname" | "resolution">[],
  releaseId: string,
): Promise<string> {
  const parts = targets
    .map(
      (target) =>
        `${target.hostname}=${target.resolution.publishedVersionId}`,
    )
    .sort();
  const text = JSON.stringify({ releaseId, targets: parts });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The name of a site's regional warmer in a pool. */
export function regionalWarmerName(pool: string, siteId: string): string {
  return `warm:${pool}:${siteId}`;
}

/** The name of a pool's anchor; `attempt` > 1 after a misplaced anchor. */
export function anchorName(pool: string, attempt: number): string {
  return attempt <= 1 ? `anchor:${pool}` : `anchor:${pool}:${attempt}`;
}

export function siteLockName(siteId: string): string {
  return `site:${siteId}`;
}

/**
 * A job older than this ends as failed, whatever is left. The site lock
 * never renews a lease past this age either (FC-H2).
 */
export const WARM_JOB_MAX_AGE_MS = 3 * 60 * 60_000;

export const WARM_SLOTS_NAME = "slots";
export const WARM_SWEEP_NAME = "sweep";
