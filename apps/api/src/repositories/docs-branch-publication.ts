import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import {
  type DocsPublicationSummary,
  type PublishDocsBranchResult,
} from "@doxahq/contracts/docs-branches";
import { DocsContentError } from "../services/docs-content/errors";
import { withDocsPublicationEffects } from "./docs-cache-mutation";
import { recordPublication, type PublicationAttribution } from "./docs-publications";
import { retireBranchPreview } from "./docs-branch-preview-gc";
import { nextDocsVersionNumber } from "./docs-version-numbers";
import { followPublishedPages, type PageMove } from "./page-locks";
import {
  closePublishedReview,
  lockReviewForPublication,
  publicationBaseline,
} from "./generation-review-publication";

export interface PublishStoredBranchInput {
  userId: string;
  projectId: string;
  branch: string;
  expectedBaseVersionId: string;
  expectedRevision: number;
  eraseBranch: boolean;
  versionId: string;
  artifactPrefix: string;
  manifestPath: string;
  summary: DocsPublicationSummary;
  attribution?: PublicationAttribution;
  /** Pages that the publication moves, so their locks follow them. */
  pageMoves?: readonly PageMove[];
  /** Pages that the publication removes, so their locks go with them. */
  removedHrefs?: readonly string[];
}

/** The branch changed after the user reviewed it, so the review is stale. */
export function branchChangedSinceReview(): DocsContentError {
  return new DocsContentError(
    "conflict",
    "The branch changed after you reviewed it. Review the changes and publish again.",
  );
}

/**
 * `collectEntryIds` names the storage entries to collect after the commit.
 * `review` is set when the branch was a generation review.
 */
export interface StoredBranchPublication {
  result: PublishDocsBranchResult;
  collectEntryIds: string[];
  review: { backupBranchName: string | null } | null;
}

export class DocsBranchPublicationRepository {
  private readonly db;

  constructor(
    private readonly env: Parameters<typeof withDocsPublicationEffects>[1],
  ) {
    this.db = createDb(env);
  }

  publish(input: PublishStoredBranchInput): Promise<StoredBranchPublication> {
    return withDocsPublicationEffects(
      this.db,
      this.env,
      async (tx, enqueue, enqueuePrerender) => {
        const [owned] = await tx
          .select({ siteId: schema.docsSites.id })
          .from(schema.projects)
          .innerJoin(
            schema.docsSites,
            eq(schema.docsSites.projectId, schema.projects.id),
          )
          .where(
            and(
              eq(schema.projects.id, input.projectId),
              eq(schema.projects.userId, input.userId),
            ),
          )
          .limit(1);

        if (!owned) {
          throw new DocsContentError("branch_not_found", "Branch not found.");
        }

        const [site] = await tx
          .select()
          .from(schema.docsSites)
          .where(eq(schema.docsSites.id, owned.siteId))
          .for("update")
          .limit(1);

        if (site?.publishedVersionId !== input.expectedBaseVersionId) {
          throw new DocsContentError(
            "branch_behind",
            "Main changed. Synchronize this branch first.",
          );
        }

        const condition =
          input.branch === "main"
            ? and(
                eq(schema.docsBranches.kind, "hidden"),
                eq(schema.docsBranches.ownerUserId, input.userId),
              )
            : and(
                eq(schema.docsBranches.kind, "named"),
                eq(schema.docsBranches.id, input.branch),
              );
        const [branch] = await tx
          .select()
          .from(schema.docsBranches)
          .where(
            and(
              eq(schema.docsBranches.siteId, site.id),
              eq(schema.docsBranches.ownerUserId, input.userId),
              condition,
            ),
          )
          .for("update")
          .limit(1);

        if (!branch) {
          throw new DocsContentError("branch_not_found", "Branch not found.");
        }

        if (branch.baseVersionId !== input.expectedBaseVersionId) {
          throw new DocsContentError(
            "branch_behind",
            "Main changed. Synchronize this branch first.",
          );
        }

        if (branch.revision !== input.expectedRevision) {
          throw branchChangedSinceReview();
        }

        const review = await lockReviewForPublication(tx, branch);

        const changes = await tx
          .select({
            path: schema.docsBranchChanges.path,
            kind: schema.docsBranchChanges.kind,
            origin: schema.docsBranchChanges.origin,
          })
          .from(schema.docsBranchChanges)
          .where(eq(schema.docsBranchChanges.branchId, branch.id));

        if (changes.length === 0) {
          throw new DocsContentError(
            "no_changes",
            "This branch has no changes to publish.",
          );
        }

        const versionNumber = await nextDocsVersionNumber(tx, {
          siteId: site.id,
          channel: "production",
        });
        const [version] = await tx
          .insert(schema.docsVersions)
          .values({
            id: input.versionId,
            siteId: site.id,
            versionNumber,
            status: "published",
            channel: "production",
            artifactPrefix: input.artifactPrefix,
            manifestPath: input.manifestPath,
            baselineVersionId: input.expectedBaseVersionId,
            ...(await publicationBaseline(tx, {
              siteId: site.id,
              versionId: input.versionId,
              baseVersionId: input.expectedBaseVersionId,
              review,
            })),
          })
          .returning({
            id: schema.docsVersions.id,
            versionNumber: schema.docsVersions.versionNumber,
          });

        if (!version) {
          throw new Error("Branch publication version insert returned no row");
        }

        await tx
          .update(schema.docsSites)
          .set({
            publishedVersionId: version.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.docsSites.id, site.id));
        const publicationId = await recordPublication(tx, {
          siteId: site.id,
          versionId: version.id,
          previousVersionId: input.expectedBaseVersionId,
          kind: review ? "generation" : "editor",
          actorUserId: input.userId,
          branchName: branch.kind === "named" ? branch.name : null,
          summary: input.summary,
          attribution: input.attribution,
        });

        // A lock stays with its page wherever the publication moves it.
        await followPublishedPages(tx, {
          siteId: site.id,
          moves: input.pageMoves ?? [],
          removedHrefs: input.removedHrefs ?? [],
        });

        // A review branch has done its job once its generation is live.
        const branchErased =
          branch.kind === "hidden" || input.eraseBranch || review !== null;
        const closedReview = review
          ? await closePublishedReview(tx, {
              review,
              siteId: site.id,
              ownerUserId: branch.ownerUserId,
              actorUserId: input.userId,
              previousVersionId: input.expectedBaseVersionId,
              publishedVersionId: version.id,
              publishedAt: new Date(),
            })
          : null;
        const collectEntryIds = branchErased
          ? await retireBranchPreview(tx, {
              branchId: branch.id,
              siteId: site.id,
            })
          : [];

        if (branchErased) {
          await tx
            .delete(schema.docsBranches)
            .where(eq(schema.docsBranches.id, branch.id));
        } else {
          await tx
            .delete(schema.docsBranchChanges)
            .where(eq(schema.docsBranchChanges.branchId, branch.id));
          await tx
            .update(schema.docsBranches)
            .set({
              baseVersionId: version.id,
              revision: branch.revision + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.docsBranches.id, branch.id));
        }

        await enqueue({ siteId: site.id });
        await enqueuePrerender({
          siteId: site.id,
          publishedVersionId: version.id,
          reason: "editor_publication",
        });

        return {
          result: {
            versionId: version.id,
            versionNumber: version.versionNumber,
            publicationId,
            branchErased,
          },
          collectEntryIds,
          review: closedReview,
        };
      },
    );
  }
}
