import { z } from "zod";

/**
 * Generic storage garbage collection.
 *
 * A feature that writes derived objects registers one collector. The feature
 * enqueues an entry when a resource stops serving production. A scheduled
 * runner claims due entries, asks the collector to inspect the resource once
 * more, and deletes the objects only when the collector still reports the
 * resource as unreferenced.
 *
 * The entry stores a typed resource, never a raw object key. The collector
 * owns the mapping from resource to storage keys.
 */

export const STORAGE_GC_LIMITS = {
  /** Entries claimed in one scheduled run. */
  claimLimit: 20,
  /** Days a finished entry stays readable before the runner prunes it. */
  historyDays: 30,
  /** Objects deleted for one entry in one run. */
  objectsPerEntry: 2_000,
  /** Objects sent in one storage delete call. */
  objectsPerDelete: 500,
  leaseSeconds: 5 * 60,
  maxAttempts: 6,
  maxErrorMessageLength: 300,
} as const;

export const storageGcTargetSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,63}$/, "Expected a snake_case collector target");

export const storageGcStatusSchema = z.enum([
  "pending",
  "running",
  "collected",
  "retained",
  "failed",
]);

export const storageGcReasonSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-z0-9_]*$/, "Expected a snake_case reason");

export const storageGcEntrySchema = z
  .object({
    id: z.uuid(),
    target: storageGcTargetSchema,
    resourceKey: z.string().min(1).max(400),
    resource: z.unknown(),
    reason: storageGcReasonSchema,
    claimToken: z.string().min(16).max(200),
    attempt: z.number().int().min(1).max(STORAGE_GC_LIMITS.maxAttempts),
  })
  .strict();

export type StorageGcStatus = z.infer<typeof storageGcStatusSchema>;
export type StorageGcEntry = z.infer<typeof storageGcEntrySchema>;

/**
 * A retained resource with `recheckAfterSeconds` returns to the work list,
 * because its reference can go away later. A retained resource without it
 * stays retained until a feature enqueues it again.
 */
export type StorageGcInspection =
  | { status: "collect" }
  | { status: "retain"; reason: string; recheckAfterSeconds?: number };

export interface StorageGcCollection {
  deletedObjects: number;
  /** "incomplete" asks the runner to keep the entry for the next run. */
  status: "complete" | "incomplete";
  /** With "incomplete": the delay before the next attempt. */
  recheckAfterSeconds?: number;
}

/** One feature's deletion policy for one kind of derived resource. */
export interface StorageCollector<TResource = unknown> {
  readonly target: string;
  /** Validates the stored resource. A parse failure retires the entry. */
  parse(resource: unknown): TResource;
  /** Last check before deletion. The runner never deletes a retained resource. */
  inspect(resource: TResource): Promise<StorageGcInspection>;
  collect(resource: TResource): Promise<StorageGcCollection>;
}

export interface StorageGcRunResult {
  claimed: number;
  /** Finished entries removed from the work list in this run. */
  pruned: number;
  collected: number;
  retained: number;
  incomplete: number;
  failed: number;
  /** Entries whose collector is not registered in this deployment. */
  skipped: number;
  deletedObjects: number;
  pendingCount: number;
  failedCount: number;
  exhaustedCount: number;
  oldestEntryAgeSeconds: number;
}

/** Resource of the `docs_prerender_render` collector. */
export const docsPrerenderRenderResourceSchema = z
  .object({
    siteId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/),
    renderId: z.string().regex(/^[a-f0-9]{64}$/),
    hostname: z.string().min(1).max(253).optional(),
  })
  .strict();

export type DocsPrerenderRenderResource = z.infer<
  typeof docsPrerenderRenderResourceSchema
>;

export const DOCS_PRERENDER_RENDER_TARGET = "docs_prerender_render" as const;

export function createDocsPrerenderRenderKey(
  resource: Pick<DocsPrerenderRenderResource, "siteId" | "renderId">,
): string {
  return `${resource.siteId}/${resource.renderId}`;
}

const docsVersionResourceSchema = z
  .object({
    siteId: z.uuid(),
    versionId: z.uuid(),
  })
  .strict();

export const docsPreviewVersionResourceSchema = docsVersionResourceSchema;
export const docsOrphanVersionPrefixResourceSchema = docsVersionResourceSchema;

export type DocsPreviewVersionResource = z.infer<
  typeof docsPreviewVersionResourceSchema
>;
export type DocsOrphanVersionPrefixResource = z.infer<
  typeof docsOrphanVersionPrefixResourceSchema
>;

export const DOCS_PREVIEW_VERSION_TARGET = "docs_preview_version" as const;
export const DOCS_ORPHAN_VERSION_PREFIX_TARGET =
  "docs_orphan_version_prefix" as const;

export function createDocsVersionResourceKey(
  resource: DocsPreviewVersionResource,
): string {
  return `${resource.siteId}/${resource.versionId}`;
}

/**
 * Resource of the `docs_site_blobs` collector: the content-addressed blobs of
 * one site. The collector deletes a blob only when no version tree of the
 * site references it.
 */
export const docsSiteBlobsResourceSchema = z
  .object({
    siteId: z.uuid(),
  })
  .strict();

export type DocsSiteBlobsResource = z.infer<typeof docsSiteBlobsResourceSchema>;

export const DOCS_SITE_BLOBS_TARGET = "docs_site_blobs" as const;

export function createDocsSiteBlobsResourceKey(
  resource: DocsSiteBlobsResource,
): string {
  return resource.siteId;
}

/**
 * Resource of the `docs_deleted_site` collector: every stored object of a
 * deleted site, except its blobs. The collector runs only when no site row
 * with this id exists, and it hands the blobs to `docs_site_blobs`.
 */
export const docsDeletedSiteResourceSchema = z
  .object({
    siteId: z.uuid(),
  })
  .strict();

export type DocsDeletedSiteResource = z.infer<
  typeof docsDeletedSiteResourceSchema
>;

export const DOCS_DELETED_SITE_TARGET = "docs_deleted_site" as const;

export function createDocsDeletedSiteResourceKey(
  resource: DocsDeletedSiteResource,
): string {
  return resource.siteId;
}

/**
 * Resource of the `docs_branch_asset_folder` collector: the one-file version
 * folder that an image upload writes for a branch. The folder stays while a
 * change row of the branch points to it. A publish copies the image into the
 * new version, so the folder is no longer needed after it.
 */
export const docsBranchAssetFolderResourceSchema = z
  .object({
    siteId: z.uuid(),
    versionId: z.uuid(),
    branchId: z.uuid(),
  })
  .strict();

export type DocsBranchAssetFolderResource = z.infer<
  typeof docsBranchAssetFolderResourceSchema
>;

export const DOCS_BRANCH_ASSET_FOLDER_TARGET =
  "docs_branch_asset_folder" as const;

/**
 * Resource of the `docs_retired_version` collector: a version row that
 * stopped serving, and with it the folder that its `artifact_prefix` names.
 * Several rows can share one folder (a promotion reuses its preview's
 * folder), so the collector deletes the folder only when the retention
 * policy keeps none of them, and marks every one of them as collected.
 */
export const docsRetiredVersionResourceSchema = docsVersionResourceSchema;

export type DocsRetiredVersionResource = z.infer<
  typeof docsRetiredVersionResourceSchema
>;

export const DOCS_RETIRED_VERSION_TARGET = "docs_retired_version" as const;

/**
 * Resource of the `docs_generation_state` collector: the generation state
 * that one version wrote, `sites/<siteId>/generation-state/<versionId>/`.
 * Several versions can name it (an edited or reviewed version inherits the
 * state of its source), so the collector keeps it while any of them can be a
 * baseline.
 */
export const docsGenerationStateResourceSchema = docsVersionResourceSchema;

export type DocsGenerationStateResource = z.infer<
  typeof docsGenerationStateResourceSchema
>;

export const DOCS_GENERATION_STATE_TARGET = "docs_generation_state" as const;

/** Days between two inspections of a resource that the policy keeps. */
export const RETAINED_BY_POLICY_RECHECK_SECONDS = 24 * 60 * 60;
