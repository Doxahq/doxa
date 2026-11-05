import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";

import type { Env } from "../env";
import { createGeneratedDocsHostname } from "../utils/docs-url";
import { withDocsCacheInvalidation } from "./docs-cache-mutation";
import {
  collectableRenderColumns,
  enqueueDocsPrerenderRenderCollection,
} from "./docs-prerender-tasks";
import {
  enqueueDocsSearchIndexCollection,
  listCollectableDocsSearchIndexes,
} from "./docs-search-indexes";
import { enqueueDocsDeletedSite } from "./docs-version-gc-entries";

export type ProjectDeletionErrorCode = "project_not_found" | "generation_active";

export class ProjectDeletionError extends Error {
  constructor(
    readonly code: ProjectDeletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDeletionError";
  }
}

export const GENERATION_ACTIVE_DELETE_MESSAGE =
  "Finish or cancel the running generation before deleting this project.";

export interface DeletedProject {
  projectId: string;
  siteId: string | null;
  storageEntryIds: string[];
}

/**
 * Deletes a project and records its stored objects for collection.
 *
 * The database rows go in one transaction through the foreign key cascade.
 * The same transaction queues a cache purge for every hostname of the site,
 * a collection entry for every pre-rendered output, and one entry for the
 * site storage. The garbage collector deletes the objects later, after it
 * checks that the site row is gone.
 */
export class ProjectDeletionRepository {
  private readonly db;

  constructor(
    private readonly env: Pick<
      Env,
      | "DATABASE_URL"
      | "HYPERDRIVE"
      | "HYPERDRIVE_CACHE_DISABLED"
      | "DOCS_CACHE_INVALIDATOR"
      | "DOCS_BASE_DOMAIN"
    >,
  ) {
    this.db = createDb(env);
  }

  async hasActiveGeneration(projectId: string): Promise<boolean> {
    const [job] = await this.db
      .select({ id: schema.generationJobs.id })
      .from(schema.generationJobs)
      .where(
        and(
          eq(schema.generationJobs.projectId, projectId),
          inArray(schema.generationJobs.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    return Boolean(job);
  }

  deleteForUser(input: {
    userId: string;
    projectId: string;
  }): Promise<DeletedProject> {
    return withDocsCacheInvalidation(
      this.db,
      this.env,
      async (tx, enqueueInvalidation) => {
        const [project] = await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.id, input.projectId),
              eq(schema.projects.userId, input.userId),
            ),
          )
          .for("update")
          .limit(1);

        if (!project) {
          throw new ProjectDeletionError(
            "project_not_found",
            "Project not found.",
          );
        }

        // A job insert takes a key share lock on the project row for its
        // foreign key, which conflicts with this update lock. A job that was
        // inserted first is visible here, and a later insert fails after
        // the delete commits.
        const [activeJob] = await tx
          .select({ id: schema.generationJobs.id })
          .from(schema.generationJobs)
          .where(
            and(
              eq(schema.generationJobs.projectId, project.id),
              inArray(schema.generationJobs.status, ["queued", "running"]),
            ),
          )
          .limit(1);

        if (activeJob) {
          throw new ProjectDeletionError(
            "generation_active",
            GENERATION_ACTIVE_DELETE_MESSAGE,
          );
        }

        const [site] = await tx
          .select({ id: schema.docsSites.id, slug: schema.docsSites.slug })
          .from(schema.docsSites)
          .where(eq(schema.docsSites.projectId, project.id))
          .limit(1);
        const domains = site
          ? await tx
              .select({ hostname: schema.docsDomains.hostname })
              .from(schema.docsDomains)
              .where(eq(schema.docsDomains.siteId, site.id))
          : [];
        const renders = site
          ? await tx
              .selectDistinct(collectableRenderColumns)
              .from(schema.docsPrerenderTasks)
              .where(eq(schema.docsPrerenderTasks.siteId, site.id))
          : [];

        const searchIndexes = site
          ? await listCollectableDocsSearchIndexes(tx, site.id)
          : [];

        await tx.delete(schema.projects).where(eq(schema.projects.id, project.id));

        if (!site) {
          return { projectId: project.id, siteId: null, storageEntryIds: [] };
        }

        const hostnames = new Set(domains.map(({ hostname }) => hostname));
        const generated = createGeneratedDocsHostname(
          site.slug,
          this.env.DOCS_BASE_DOMAIN,
        );
        if (generated) hostnames.add(generated);

        await enqueueInvalidation({ siteId: site.id });
        for (const hostname of hostnames) {
          await enqueueInvalidation({ siteId: site.id, hostname });
        }

        const storageEntryIds: string[] = [];
        for (const render of renders) {
          const id = await enqueueDocsPrerenderRenderCollection(
            tx,
            render,
            "project_deleted",
          );
          if (id) storageEntryIds.push(id);
        }
        for (const resource of searchIndexes) {
          const id = await enqueueDocsSearchIndexCollection(
            tx,
            resource,
            "project_deleted",
          );
          if (id) storageEntryIds.push(id);
        }
        const siteEntryId = await enqueueDocsDeletedSite(tx, {
          siteId: site.id,
        });
        if (siteEntryId) storageEntryIds.push(siteEntryId);

        return { projectId: project.id, siteId: site.id, storageEntryIds };
      },
    );
  }
}
