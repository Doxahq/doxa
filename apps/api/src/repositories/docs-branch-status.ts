import { and, count, desc, eq, gt, or } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import type { DocsBranchStatus } from "@doxahq/contracts/docs-branches";
import type { Env } from "../env";
import { DocsContentError } from "../services/docs-content/errors";
import { DocsBranchesRepository } from "./docs-branches";

/** Small indexed read used by the editor's status poll. */
export class DocsBranchStatusRepository {
  private readonly db;
  private readonly branches;

  constructor(env: Env) {
    this.db = createDb(env);
    this.branches = new DocsBranchesRepository(env);
  }

  async get(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<DocsBranchStatus> {
    const context = await this.branches.resolveForUser(input);

    if (!context) {
      throw new DocsContentError("branch_not_found", "Branch not found.");
    }

    const { site, branch } = context;

    const [latest] = await this.db
      .select({
        kind: schema.docsPublications.kind,
        createdAt: schema.docsPublications.createdAt,
        actorName: schema.user.name,
      })
      .from(schema.docsPublications)
      .leftJoin(
        schema.user,
        eq(schema.user.id, schema.docsPublications.actorUserId),
      )
      .where(eq(schema.docsPublications.siteId, site.id))
      .orderBy(
        desc(schema.docsPublications.createdAt),
        desc(schema.docsPublications.id),
      )
      .limit(1);

    const baseVersionId = branch?.baseVersionId ?? site.mainVersionId;
    const behind = baseVersionId !== site.mainVersionId;

    const [basePublication] = behind
      ? await this.db
          .select({
            createdAt: schema.docsPublications.createdAt,
            id: schema.docsPublications.id,
          })
          .from(schema.docsPublications)
          .where(
            and(
              eq(schema.docsPublications.siteId, site.id),
              eq(schema.docsPublications.versionId, baseVersionId),
            ),
          )
          .orderBy(
            desc(schema.docsPublications.createdAt),
            desc(schema.docsPublications.id),
          )
          .limit(1)
      : [];

    const [newer] =
      behind && basePublication
        ? await this.db
            .select({ total: count() })
            .from(schema.docsPublications)
            .where(
              and(
                eq(schema.docsPublications.siteId, site.id),
                or(
                  gt(
                    schema.docsPublications.createdAt,
                    basePublication.createdAt,
                  ),
                  and(
                    eq(
                      schema.docsPublications.createdAt,
                      basePublication.createdAt,
                    ),
                    gt(schema.docsPublications.id, basePublication.id),
                  ),
                ),
              ),
            )
        : [];

    const [changeCount] = branch
      ? await this.db
          .select({ total: count() })
          .from(schema.docsBranchChanges)
          .where(eq(schema.docsBranchChanges.branchId, branch.id))
      : [];
    const [previewChannel] = branch
      ? await this.db
          .select({ hostname: schema.docsPreviewChannels.hostname })
          .from(schema.docsPreviewChannels)
          .where(eq(schema.docsPreviewChannels.branchId, branch.id))
          .limit(1)
      : [];

    return {
      branch:
        branch?.kind === "named"
          ? {
              id: branch.id,
              kind: "named",
              name: branch.name,
              revision: branch.revision,
            }
          : {
              id: branch?.id ?? null,
              kind: "hidden",
              name: null,
              revision: branch?.revision ?? 0,
            },
      baseVersionId,
      main: {
        versionId: site.mainVersionId,
        versionNumber: site.mainVersionNumber,
        latestPublication: {
          kind: latest?.kind ?? "import",
          actorName: latest?.actorName ?? null,
          createdAt: (latest?.createdAt ?? site.mainCreatedAt).toISOString(),
        },
      },
      behind,
      publicationsSinceBase: behind
        ? basePublication
          ? (newer?.total ?? 0)
          : 1
        : 0,
      changeCount: changeCount?.total ?? 0,
      preview: previewChannel
        ? {
            hostname: previewChannel.hostname,
            upToDate: branch?.previewRevision === branch?.revision,
          }
        : null,
    };
  }
}
