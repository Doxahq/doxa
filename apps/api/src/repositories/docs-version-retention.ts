import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import { buildArtifactPrefix, generationStateOwnerVersionId } from "@doxahq/docs-engine";
import type {
  DocsGenerationStateResource,
  DocsRetiredVersionResource,
  StorageGcInspection,
} from "@doxahq/contracts/storage-gc";
import { z } from "zod";

import { resolveRetentionPolicy } from "../services/retention-policy";
import {
  inspectSharedVersionStorage,
  type VersionPointer,
  type VersionRetentionFacts,
} from "../services/storage-gc/version-retention";
import type { DocsMutationTransaction } from "./docs-cache-invalidations";
import { enqueueDocsGenerationState } from "./docs-version-gc-entries";

type RetentionReader = DoxaDb | DocsMutationTransaction;

export interface DocsVersionRetentionStore {
  /**
   * Decides, under the site lock, whether the folder of a retired version
   * goes. When it goes, every row that shares the folder is marked as
   * collected in the same transaction, so a restore or a promotion that
   * waits for the lock refuses it, and their generation states are queued.
   */
  claimRetiredVersionFolder(
    resource: DocsRetiredVersionResource,
    now: Date,
  ): Promise<StorageGcInspection>;
  /** The version whose id names the folder of a retired version. */
  findFolderOwner(resource: DocsRetiredVersionResource): Promise<string | null>;
  inspectGenerationState(
    resource: DocsGenerationStateResource,
    now: Date,
  ): Promise<StorageGcInspection>;
}

interface StoredVersionRow {
  id: string;
  channel: "production" | "preview";
  status: "staged" | "published" | "failed";
  versionNumber: number;
  createdAt: Date;
  previewReplacedAt: Date | null;
  artifactsCollectedAt: Date | null;
  generationStatePrefix: string;
}

const versionRowColumns = {
  id: schema.docsVersions.id,
  channel: schema.docsVersions.channel,
  status: schema.docsVersions.status,
  versionNumber: schema.docsVersions.versionNumber,
  createdAt: schema.docsVersions.createdAt,
  previewReplacedAt: schema.docsVersions.previewReplacedAt,
  artifactsCollectedAt: schema.docsVersions.artifactsCollectedAt,
  generationStatePrefix: schema.docsVersions.generationStatePrefix,
};

export class DocsVersionRetentionRepository
  implements DocsVersionRetentionStore
{
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  claimRetiredVersionFolder(
    resource: DocsRetiredVersionResource,
    now: Date,
  ): Promise<StorageGcInspection> {
    return this.db.transaction(async (tx) => {
      const site = await lockSite(tx, resource.siteId);
      if (!site) return { status: "retain", reason: "site_deleted" };

      const owner = await findFolderOwner(tx, resource);
      if (!owner) return { status: "retain", reason: "version_not_found" };

      const rows = await tx
        .select(versionRowColumns)
        .from(schema.docsVersions)
        .where(
          and(
            eq(schema.docsVersions.siteId, resource.siteId),
            or(
              eq(schema.docsVersions.id, owner),
              eq(
                schema.docsVersions.artifactPrefix,
                buildArtifactPrefix(resource.siteId, owner),
              ),
            ),
          ),
        );
      const inspection = inspectSharedVersionStorage(
        await retentionFacts(tx, { ...site, siteId: resource.siteId }, rows),
        resolveRetentionPolicy({ id: site.projectId }),
        now,
      );
      if (inspection.status !== "collect") return inspection;

      const ids = rows.map(({ id }) => id);
      if (ids.length > 0) {
        await tx
          .update(schema.docsVersions)
          .set({ artifactsCollectedAt: now })
          .where(
            and(
              inArray(schema.docsVersions.id, ids),
              isNull(schema.docsVersions.artifactsCollectedAt),
            ),
          );
      }
      for (const stateOwner of stateOwners(resource.siteId, rows)) {
        await enqueueDocsGenerationState(
          tx,
          { siteId: resource.siteId, versionId: stateOwner },
          "version_collected",
        );
      }
      return inspection;
    });
  }

  findFolderOwner(resource: DocsRetiredVersionResource): Promise<string | null> {
    return findFolderOwner(this.db, resource);
  }

  async inspectGenerationState(
    resource: DocsGenerationStateResource,
    now: Date,
  ): Promise<StorageGcInspection> {
    const [site] = await this.db
      .select({
        projectId: schema.docsSites.projectId,
        publishedVersionId: schema.docsSites.publishedVersionId,
      })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.id, resource.siteId))
      .limit(1);
    if (!site) return { status: "retain", reason: "site_deleted" };

    const rows = await this.db
      .select(versionRowColumns)
      .from(schema.docsVersions)
      .where(
        and(
          eq(schema.docsVersions.siteId, resource.siteId),
          eq(
            schema.docsVersions.generationStatePrefix,
            generationStatePrefixOf(resource),
          ),
        ),
      );
    return inspectSharedVersionStorage(
      await retentionFacts(this.db, { ...site, siteId: resource.siteId }, rows),
      resolveRetentionPolicy({ id: site.projectId }),
      now,
    );
  }
}

/** The stored prefix that names the generation state of one version. */
export function generationStatePrefixOf(
  resource: DocsGenerationStateResource,
): string {
  return `sites/${resource.siteId}/generation-state/${resource.versionId}`;
}

/**
 * The version whose id names a folder, read from the stored prefix of the
 * retired row. A promotion stores the prefix of its source preview.
 */
export function artifactPrefixOwnerVersionId(
  siteId: string,
  artifactPrefix: string,
): string | null {
  const root = `${buildArtifactPrefix(siteId, "")}`;
  if (!artifactPrefix.startsWith(root)) return null;
  const candidate = artifactPrefix.slice(root.length);
  return z.uuid().safeParse(candidate).success &&
    buildArtifactPrefix(siteId, candidate) === artifactPrefix
    ? candidate
    : null;
}

async function findFolderOwner(
  db: RetentionReader,
  resource: DocsRetiredVersionResource,
): Promise<string | null> {
  const [row] = await db
    .select({ artifactPrefix: schema.docsVersions.artifactPrefix })
    .from(schema.docsVersions)
    .where(
      and(
        eq(schema.docsVersions.id, resource.versionId),
        eq(schema.docsVersions.siteId, resource.siteId),
      ),
    )
    .limit(1);
  return row
    ? artifactPrefixOwnerVersionId(resource.siteId, row.artifactPrefix)
    : null;
}

async function lockSite(tx: DocsMutationTransaction, siteId: string) {
  const [site] = await tx
    .select({
      projectId: schema.docsSites.projectId,
      publishedVersionId: schema.docsSites.publishedVersionId,
    })
    .from(schema.docsSites)
    .where(eq(schema.docsSites.id, siteId))
    .for("update")
    .limit(1);
  return site ?? null;
}

function stateOwners(siteId: string, rows: readonly StoredVersionRow[]): string[] {
  return [
    ...new Set(
      rows.flatMap(({ generationStatePrefix }) => {
        const owner = generationStateOwnerVersionId(siteId, generationStatePrefix);
        return owner ? [owner] : [];
      }),
    ),
  ];
}

/** Reads the pointers and the history position of each row. */
async function retentionFacts(
  db: RetentionReader,
  site: { siteId: string; publishedVersionId: string | null },
  rows: readonly StoredVersionRow[],
): Promise<VersionRetentionFacts[]> {
  const ids = rows.map(({ id }) => id);
  if (ids.length === 0) return [];

  const [pointers, succeeded, lastPublished] = await Promise.all([
    findPointers(db, site, ids),
    findSucceededGenerations(db, ids),
    findLastPublications(db, ids),
  ]);

  return Promise.all(
    rows.map(async (row) => ({
      channel: row.channel,
      createdAt: row.createdAt,
      previewReplacedAt: row.previewReplacedAt,
      artifactsCollectedAt: row.artifactsCollectedAt,
      pointers: pointers.get(row.id) ?? [],
      history:
        row.channel === "production" && row.status === "published"
          ? {
              rank: await productionRank(db, site.siteId, row.versionNumber),
              lastPublishedAt: lastPublished.get(row.id) ?? row.createdAt,
            }
          : null,
      hasSucceededGeneration: succeeded.has(row.id),
    })),
  );
}

async function findPointers(
  db: RetentionReader,
  site: { siteId: string; publishedVersionId: string | null },
  ids: string[],
): Promise<Map<string, VersionPointer[]>> {
  const result = new Map<string, VersionPointer[]>();
  const add = (versionId: string | null, pointer: VersionPointer) => {
    if (!versionId || !ids.includes(versionId)) return;
    result.set(versionId, [...(result.get(versionId) ?? []), pointer]);
  };
  add(site.publishedVersionId, "published");

  const [channels, branches, reviews, jobs] = await Promise.all([
    db
      .select({ versionId: schema.docsPreviewChannels.currentVersionId })
      .from(schema.docsPreviewChannels)
      .where(inArray(schema.docsPreviewChannels.currentVersionId, ids)),
    db
      .select({ versionId: schema.docsBranches.baseVersionId })
      .from(schema.docsBranches)
      .where(inArray(schema.docsBranches.baseVersionId, ids)),
    db
      .select({ versionId: schema.generationReviews.generatedVersionId })
      .from(schema.generationReviews)
      .where(
        and(
          eq(schema.generationReviews.status, "open"),
          inArray(schema.generationReviews.generatedVersionId, ids),
        ),
      ),
    db
      .select({
        docsVersionId: schema.generationJobs.docsVersionId,
        baselineVersionId: schema.generationJobs.baselineVersionId,
        seedVersionId: schema.generationJobs.seedVersionId,
      })
      .from(schema.generationJobs)
      .where(
        and(
          inArray(schema.generationJobs.status, ["queued", "running"]),
          or(
            inArray(schema.generationJobs.docsVersionId, ids),
            inArray(schema.generationJobs.baselineVersionId, ids),
            inArray(schema.generationJobs.seedVersionId, ids),
          ),
        ),
      ),
  ]);
  for (const { versionId } of channels) add(versionId, "preview_channel");
  for (const { versionId } of branches) add(versionId, "branch_base");
  for (const { versionId } of reviews) add(versionId, "open_review");
  for (const job of jobs) {
    add(job.docsVersionId, "active_generation");
    add(job.baselineVersionId, "active_generation");
    add(job.seedVersionId, "active_generation");
  }
  return result;
}

async function findSucceededGenerations(
  db: RetentionReader,
  ids: string[],
): Promise<Set<string>> {
  const rows = await db
    .select({ versionId: schema.generationJobs.docsVersionId })
    .from(schema.generationJobs)
    .where(
      and(
        eq(schema.generationJobs.status, "succeeded"),
        inArray(schema.generationJobs.docsVersionId, ids),
      ),
    );
  return new Set(rows.flatMap(({ versionId }) => (versionId ? [versionId] : [])));
}

async function findLastPublications(
  db: RetentionReader,
  ids: string[],
): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      versionId: schema.docsPublications.versionId,
      lastPublishedAt: sql<Date>`max(${schema.docsPublications.createdAt})`.mapWith(
        (value: string | Date) => new Date(value),
      ),
    })
    .from(schema.docsPublications)
    .where(inArray(schema.docsPublications.versionId, ids))
    .groupBy(schema.docsPublications.versionId);
  return new Map(rows.map((row) => [row.versionId, row.lastPublishedAt]));
}

/** 1 for the newest published production version of the site. */
async function productionRank(
  db: RetentionReader,
  siteId: string,
  versionNumber: number,
): Promise<number> {
  const [row] = await db
    .select({ newer: sql<number>`count(*)::int` })
    .from(schema.docsVersions)
    .where(
      and(
        eq(schema.docsVersions.siteId, siteId),
        eq(schema.docsVersions.channel, "production"),
        eq(schema.docsVersions.status, "published"),
        gt(schema.docsVersions.versionNumber, versionNumber),
      ),
    );
  return (row?.newer ?? 0) + 1;
}
