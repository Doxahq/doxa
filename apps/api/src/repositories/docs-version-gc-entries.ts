import {
  DOCS_BRANCH_ASSET_FOLDER_TARGET,
  DOCS_DELETED_SITE_TARGET,
  DOCS_GENERATION_STATE_TARGET,
  DOCS_ORPHAN_VERSION_PREFIX_TARGET,
  DOCS_RETIRED_VERSION_TARGET,
  DOCS_PREVIEW_VERSION_TARGET,
  DOCS_SITE_BLOBS_TARGET,
  createDocsDeletedSiteResourceKey,
  createDocsSiteBlobsResourceKey,
  createDocsVersionResourceKey,
  type DocsBranchAssetFolderResource,
  type DocsDeletedSiteResource,
  type DocsGenerationStateResource,
  type DocsOrphanVersionPrefixResource,
  type DocsRetiredVersionResource,
  type DocsPreviewVersionResource,
  type DocsSiteBlobsResource,
} from "@doxahq/contracts/storage-gc";
import { HOSTNAME_READER_GRACE_SECONDS } from "@doxahq/contracts";
import { createDb, type DbEnv } from "@doxahq/db";

import { enqueueStorageCollection } from "./storage-gc";

/**
 * A replaced preview keeps its folder for renders that started before the
 * channel moved. An erased branch has no channel and no hostname, so no
 * request can reach its folder, and the folder goes at once.
 */
const PREVIEW_VERSION_GRACE_SECONDS = {
  preview_replaced: 60 * 60,
  branch_erased: 0,
} as const;
const ORPHAN_PREFIX_GRACE_SECONDS = 24 * 60 * 60;
/**
 * The upload writes its change row seconds after the folder. The grace
 * period covers that; later, the collector checks the row itself.
 */
const BRANCH_ASSET_FOLDER_GRACE_SECONDS = 60 * 60;
/**
 * The dispatcher can hold a resolved hostname for a day, so a reader can
 * still ask for the files of a deleted site during that time.
 */
const DELETED_SITE_GRACE_SECONDS = HOSTNAME_READER_GRACE_SECONDS;

/**
 * A retired version waits as long as a dispatcher can hold a resolved
 * hostname that points to it, plus renders in flight. The retention policy
 * usually keeps the version much longer, and the collector applies it when
 * it inspects the entry.
 */
const RETIRED_VERSION_GRACE_SECONDS = HOSTNAME_READER_GRACE_SECONDS;

type StorageGcWriter = Parameters<typeof enqueueStorageCollection>[0];

/** Why a version stopped serving. */
export type RetiredVersionReason =
  | "production_replaced"
  | "preview_replaced"
  | "preview_closed"
  | "review_discarded"
  | "generation_deleted";

export function enqueueDocsRetiredVersion(
  writer: StorageGcWriter,
  resource: DocsRetiredVersionResource,
  reason: RetiredVersionReason,
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_RETIRED_VERSION_TARGET,
    resourceKey: createDocsVersionResourceKey(resource),
    resource,
    reason,
    graceSeconds: RETIRED_VERSION_GRACE_SECONDS,
  });
}

export function enqueueDocsGenerationState(
  writer: StorageGcWriter,
  resource: DocsGenerationStateResource,
  reason: RetiredVersionReason | "version_collected",
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_GENERATION_STATE_TARGET,
    resourceKey: createDocsVersionResourceKey(resource),
    resource,
    reason,
    graceSeconds: RETIRED_VERSION_GRACE_SECONDS,
  });
}

export function enqueueDocsPreviewVersion(
  writer: StorageGcWriter,
  resource: DocsPreviewVersionResource,
  reason: keyof typeof PREVIEW_VERSION_GRACE_SECONDS,
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_PREVIEW_VERSION_TARGET,
    resourceKey: createDocsVersionResourceKey(resource),
    resource,
    reason,
    graceSeconds: PREVIEW_VERSION_GRACE_SECONDS[reason],
  });
}

export function enqueueDocsOrphanVersionPrefix(
  writer: StorageGcWriter,
  resource: DocsOrphanVersionPrefixResource,
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_ORPHAN_VERSION_PREFIX_TARGET,
    resourceKey: createDocsVersionResourceKey(resource),
    resource,
    reason: "materialization_started",
    graceSeconds: ORPHAN_PREFIX_GRACE_SECONDS,
  });
}

/** Records an image upload folder before the upload writes it. */
export function enqueueDocsBranchAssetFolder(
  writer: StorageGcWriter,
  resource: DocsBranchAssetFolderResource,
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_BRANCH_ASSET_FOLDER_TARGET,
    resourceKey: createDocsVersionResourceKey(resource),
    resource,
    reason: "asset_uploaded",
    graceSeconds: BRANCH_ASSET_FOLDER_GRACE_SECONDS,
  });
}

/**
 * The sweep has no grace period of its own. It never deletes a blob that is
 * younger than `BLOB_IN_FLIGHT_SECONDS`, and it runs again for such a blob.
 */
export function enqueueDocsSiteBlobs(
  writer: StorageGcWriter,
  resource: DocsSiteBlobsResource,
  reason:
    | "version_prefix_collected"
    | "legacy_storage_pruned"
    | "deleted_site_collected",
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_SITE_BLOBS_TARGET,
    resourceKey: createDocsSiteBlobsResourceKey(resource),
    resource,
    reason,
    graceSeconds: 0,
  });
}

/** Records every stored object of a deleted site for collection. */
export function enqueueDocsDeletedSite(
  writer: StorageGcWriter,
  resource: DocsDeletedSiteResource,
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_DELETED_SITE_TARGET,
    resourceKey: createDocsDeletedSiteResourceKey(resource),
    resource,
    reason: "project_deleted",
    graceSeconds: DELETED_SITE_GRACE_SECONDS,
  });
}

export class DocsVersionGcEntriesRepository {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  enqueueOrphanVersionPrefix(
    resource: DocsOrphanVersionPrefixResource,
  ): Promise<string | null> {
    return enqueueDocsOrphanVersionPrefix(this.db, resource);
  }

  enqueueBranchAssetFolder(
    resource: DocsBranchAssetFolderResource,
  ): Promise<string | null> {
    return enqueueDocsBranchAssetFolder(this.db, resource);
  }

  enqueueSiteBlobs(
    resource: DocsSiteBlobsResource,
    reason: Parameters<typeof enqueueDocsSiteBlobs>[2],
  ): Promise<string | null> {
    return enqueueDocsSiteBlobs(this.db, resource, reason);
  }
}
