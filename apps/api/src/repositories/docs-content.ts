import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import type { DocsCacheInvalidationRpc } from "@doxahq/contracts";
import type { PrerenderQueueRpc } from "@doxahq/contracts/docs-prerender-tasks";
import { withDocsPublicationEffects } from "./docs-cache-mutation";
import { recordPublication } from "./docs-publications";
import { nextDocsVersionNumber } from "./docs-version-numbers";

/** The published docs version an editor works against, scoped to its owner. */
export interface PublishedDocsContentVersion {
  projectId: string;
  projectName: string;
  projectSlug: string;
  siteId: string;
  versionId: string;
  versionNumber: number;
  artifactPrefix: string;
  manifestPath: string;
  createdAt: Date;
}

export interface CreatedDocsContentVersion {
  versionId: string;
  versionNumber: number;
  createdAt: Date;
}

/** Thrown when the site head changed during a manual publication. */
export class DocsContentVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsContentVersionConflictError";
  }
}

export interface DocsContentStateStore {
  getPublishedVersionForUser(input: {
    userId: string;
    projectId: string;
  }): Promise<PublishedDocsContentVersion | null>;
  createContentVersion(input: {
    siteId: string;
    baseVersionId: string;
    artifactPrefix: string;
    manifestPath: string;
    generationStatePrefix: string;
  }): Promise<CreatedDocsContentVersion>;
}

export class DocsContentRepository implements DocsContentStateStore {
  private readonly db;

  constructor(
    private readonly env: DbEnv & {
      DOCS_CACHE_INVALIDATOR?: DocsCacheInvalidationRpc;
      DOCS_BASE_DOMAIN?: string;
      DOXA_RENDERER_RELEASE_ID?: string;
      PRERENDER_QUEUE?: PrerenderQueueRpc;
    },
  ) {
    this.db = createDb(env);
  }

  /**
   * Resolves the editable version through project ownership. Content routes must
   * never trust a client-supplied site id or artifact prefix, so the join filters
   * on the owning user and reads the prefix straight from the published version.
   */
  async getPublishedVersionForUser(input: {
    userId: string;
    projectId: string;
  }): Promise<PublishedDocsContentVersion | null> {
    const [row] = await this.db
      .select({
        projectId: schema.projects.id,
        projectName: schema.projects.name,
        projectSlug: schema.projects.slug,
        siteId: schema.docsSites.id,
        versionId: schema.docsVersions.id,
        versionNumber: schema.docsVersions.versionNumber,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
        createdAt: schema.docsVersions.createdAt,
      })
      .from(schema.projects)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsSites.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.docsVersions,
        and(
          eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
          eq(schema.docsVersions.siteId, schema.docsSites.id),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.userId, input.userId),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * Records a manually edited version and promotes it in one transaction.
   *
   * The site row is locked and re-checked against the branch base version, so a
   * generation run that publishes at the same moment cannot be overwritten.
   */
  async createContentVersion(input: {
    siteId: string;
    baseVersionId: string;
    artifactPrefix: string;
    manifestPath: string;
    generationStatePrefix: string;
  }): Promise<CreatedDocsContentVersion> {
    return withDocsPublicationEffects(
      this.db,
      this.env,
      async (tx, enqueue, enqueuePrerender) => {
        const [site] = await tx
          .select()
          .from(schema.docsSites)
          .where(eq(schema.docsSites.id, input.siteId))
          .for("update")
          .limit(1);

        if (!site) {
          throw new DocsContentVersionConflictError("Docs site not found.");
        }
        if (site.publishedVersionId !== input.baseVersionId) {
          throw new DocsContentVersionConflictError(
            "The published documentation changed while this branch was open.",
          );
        }

        const [version] = await tx
          .insert(schema.docsVersions)
          .values({
            siteId: input.siteId,
            versionNumber: await nextDocsVersionNumber(tx, {
              siteId: input.siteId,
              channel: "production",
            }),
            status: "published",
            channel: "production",
            artifactPrefix: input.artifactPrefix,
            manifestPath: input.manifestPath,
            // A manually edited version has no repository revision behind it.
            // Leaving these null keeps it out of generation baseline selection.
            sourceRevision: null,
            sourceTreeHash: null,
            baselineVersionId: input.baseVersionId,
            generatorFingerprint: null,
            generationStatePrefix: input.generationStatePrefix,
          })
          .returning();

        if (!version) {
          throw new Error(
            "Documentation content version could not be created.",
          );
        }

        await tx
          .update(schema.docsSites)
          .set({ publishedVersionId: version.id, updatedAt: new Date() })
          .where(eq(schema.docsSites.id, input.siteId));
        await recordPublication(tx, {
          siteId: input.siteId,
          versionId: version.id,
          previousVersionId: input.baseVersionId,
          kind: "editor",
          actorUserId: null,
          branchName: null,
          summary: {},
        });
        await enqueue({ siteId: input.siteId });
        await enqueuePrerender({
          siteId: input.siteId,
          publishedVersionId: version.id,
          reason: "editor_publication",
        });

        return {
          versionId: version.id,
          versionNumber: version.versionNumber,
          createdAt: version.createdAt,
        };
      },
    );
  }
}
