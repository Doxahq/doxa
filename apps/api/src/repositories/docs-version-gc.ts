import { and, eq, like, or } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import { buildArtifactPrefix } from "@doxahq/docs-engine";

/**
 * Why a version folder must stay.
 *
 * - `shared_prefix`: another version row serves the same folder. A promoted
 *   generation reuses the folder of its source version, so the folder
 *   belongs to that row now.
 * - `not_preview`: the version is not a preview. Production folders are
 *   never collected here.
 * - `referenced`: a live pointer still uses the version. The pointer can move
 *   later, so the collector checks again.
 */
export type DocsVersionRetention = "shared_prefix" | "not_preview" | "referenced";

export interface DocsVersionGcStore {
  findPreviewVersionRetention(input: {
    siteId: string;
    versionId: string;
  }): Promise<DocsVersionRetention | null>;
  isVersionPrefixInUse(input: {
    siteId: string;
    versionId: string;
  }): Promise<boolean>;
  /**
   * The contents of the image changes of every branch of the site: pointers
   * to upload folders. A branch created from another branch copies its
   * change rows, so one folder can be on several branches.
   */
  listSiteAssetPointers(input: { siteId: string }): Promise<string[]>;
}

export class DocsVersionGcRepository implements DocsVersionGcStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async findPreviewVersionRetention(input: {
    siteId: string;
    versionId: string;
  }): Promise<DocsVersionRetention | null> {
    const rows = await findVersionRowsForPrefix(this.db, input);

    if (rows.some(({ id }) => id !== input.versionId)) {
      return "shared_prefix";
    }

    if (rows.some(({ channel }) => channel !== "preview")) {
      return "not_preview";
    }

    return (await isVersionReferenced(this.db, input.versionId))
      ? "referenced"
      : null;
  }

  /** True when any version row owns the folder, by id or by prefix. */
  async isVersionPrefixInUse(input: {
    siteId: string;
    versionId: string;
  }): Promise<boolean> {
    return (await findVersionRowsForPrefix(this.db, input)).length > 0;
  }

  async listSiteAssetPointers(input: { siteId: string }): Promise<string[]> {
    const rows = await this.db
      .select({ content: schema.docsBranchChanges.content })
      .from(schema.docsBranchChanges)
      .innerJoin(
        schema.docsBranches,
        eq(schema.docsBranches.id, schema.docsBranchChanges.branchId),
      )
      .where(
        and(
          eq(schema.docsBranches.siteId, input.siteId),
          eq(schema.docsBranchChanges.kind, "upsert"),
          like(schema.docsBranchChanges.path, "assets/%"),
        ),
      );
    return rows.flatMap(({ content }) => (content === null ? [] : [content]));
  }

  /** A deleted project removes its site row, so only then can its storage go. */
  async siteExists(siteId: string): Promise<boolean> {
    const [site] = await this.db
      .select({ id: schema.docsSites.id })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.id, siteId))
      .limit(1);
    return Boolean(site);
  }
}

function findVersionRowsForPrefix(
  db: DoxaDb,
  input: { siteId: string; versionId: string },
) {
  return db
    .select({
      id: schema.docsVersions.id,
      channel: schema.docsVersions.channel,
    })
    .from(schema.docsVersions)
    .where(
      and(
        eq(schema.docsVersions.siteId, input.siteId),
        or(
          eq(schema.docsVersions.id, input.versionId),
          eq(
            schema.docsVersions.artifactPrefix,
            buildArtifactPrefix(input.siteId, input.versionId),
          ),
        ),
      ),
    );
}

async function isVersionReferenced(
  db: DoxaDb,
  versionId: string,
): Promise<boolean> {
  const references = await Promise.all([
    db
      .select({ id: schema.docsSites.id })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.publishedVersionId, versionId))
      .limit(1),
    db
      .select({ id: schema.docsPreviewChannels.id })
      .from(schema.docsPreviewChannels)
      .where(eq(schema.docsPreviewChannels.currentVersionId, versionId))
      .limit(1),
    db
      .select({ id: schema.docsBranches.id })
      .from(schema.docsBranches)
      .where(eq(schema.docsBranches.baseVersionId, versionId))
      .limit(1),
    db
      .select({ id: schema.docsPublications.id })
      .from(schema.docsPublications)
      .where(
        or(
          eq(schema.docsPublications.versionId, versionId),
          eq(schema.docsPublications.previousVersionId, versionId),
        ),
      )
      .limit(1),
    db
      .select({ id: schema.docsVersions.id })
      .from(schema.docsVersions)
      .where(eq(schema.docsVersions.baselineVersionId, versionId))
      .limit(1),
    db
      .select({ id: schema.generationJobs.id })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.docsVersionId, versionId))
      .limit(1),
  ]);

  return references.some((rows) => rows.length > 0);
}
