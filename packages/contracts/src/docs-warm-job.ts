import { z } from "zod";

import { warmPoolSchema } from "./docs-warm-state";

/**
 * The regional warm job (M28 + M45): after a publish or a renderer deploy,
 * the docs dispatcher fills each upper-tier cache pool with a site's pages.
 * Messages and hints carry IDs and ordering only; the consumer re-reads
 * every hostname from the hostname map (spec principle 4).
 * See docs/current/production-docs-caching.md, "Regional warm job".
 */

/** The most changed pages a publish hint may name (M45). */
export const DOCS_WARM_HINT_PATH_LIMIT = 50;

/** The most hostnames of one site that one job warms. */
export const DOCS_WARM_MESSAGE_HOSTNAME_LIMIT = 10;

const releaseIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** A public page path, as the API's branch diff names it: `/`, `/guide/setup`. */
const warmPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\/[^?#\s]*$/);

/**
 * Ordering only: the pools to warm first (the publisher's) and the pages that
 * changed. Never a target: the consumer keeps only pools it knows and paths
 * that are in the site's page plan.
 */
export const docsWarmHintSchema = z
  .object({
    regions: z.array(warmPoolSchema).max(8).optional(),
    paths: z.array(warmPathSchema).max(DOCS_WARM_HINT_PATH_LIMIT).optional(),
  })
  .strict();

export type DocsWarmHint = z.infer<typeof docsWarmHintSchema>;

export const docsWarmReasonSchema = z.enum(["publish", "deploy"]);

export type DocsWarmReason = z.infer<typeof docsWarmReasonSchema>;

/** One message of `doxa-docs-warm-publish` or `doxa-docs-warm-sweep`. */
export const docsWarmMessageSchema = z
  .object({
    v: z.literal(1),
    reason: docsWarmReasonSchema,
    siteId: z.string().min(1).max(128),
    hostnames: z
      .array(z.string().min(1).max(253))
      .min(1)
      .max(DOCS_WARM_MESSAGE_HOSTNAME_LIMIT),
    /** The renderer release this job warms; stale after a newer deploy. */
    releaseId: releaseIdSchema,
    /** Publish only: the version that the sync stored, to wait for KV. */
    publishedVersionId: z.string().min(1).max(128).optional(),
    jobId: z.string().uuid(),
    priority: docsWarmHintSchema.optional(),
    enqueuedAt: z.number().int().nonnegative(),
  })
  .strict();

export type DocsWarmMessage = z.infer<typeof docsWarmMessageSchema>;

/** A pool of the site's current warm job, as `getWarmStatus` reports it. */
export const docsWarmPoolStateSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
]);

export type DocsWarmPoolState = z.infer<typeof docsWarmPoolStateSchema>;

export const docsWarmPoolStatusSchema = z
  .object({
    pool: warmPoolSchema,
    state: docsWarmPoolStateSchema,
    /** When the pool last changed state (epoch ms). */
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The site's latest warm job: no content, no hostnames. `releaseId` null and
 * no pools mean "no job in the last hour".
 */
export const docsWarmStatusSchema = z
  .object({
    siteId: z.string().min(1).max(128),
    releaseId: releaseIdSchema.nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    finishedAt: z.number().int().nonnegative().nullable(),
    pools: z.array(docsWarmPoolStatusSchema).max(8),
  })
  .strict();

export type DocsWarmStatus = z.infer<typeof docsWarmStatusSchema>;

/** `GET /projects/:projectId/warm-status` (M45b): the dashboard's view. */
export const docsWarmStatusResponseSchema = z
  .object({
    /** The site's latest regional warm job, or null when it is unknown. */
    status: docsWarmStatusSchema.nullable(),
    /** The caller's own cache pool, so the dashboard can say "your region". */
    clientRegion: warmPoolSchema.nullable(),
  })
  .strict();

export type DocsWarmStatusResponse = z.infer<typeof docsWarmStatusResponseSchema>;

/** Private service binding only (`doxa-docs-renderer#DocsHostCache`). */
export interface DocsWarmStatusRpc {
  getWarmStatus(input: { siteId: string }): Promise<DocsWarmStatus>;
}
