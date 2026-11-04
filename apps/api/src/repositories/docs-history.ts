import { and, desc, eq, lt, or } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import { z } from "zod";
import {
  docsPublicationSummarySchema,
  type DocsPublication,
  type DocsPublicationPage,
} from "@doxahq/contracts/docs-branches";
import type { DocsWarmHint } from "@doxahq/contracts/docs-warm-job";
import { DocsContentError } from "../services/docs-content/errors";
import { withDocsPublicationEffects } from "./docs-cache-mutation";
import { recordPublication, type PublicationAttribution } from "./docs-publications";

interface Cursor {
  createdAt: Date;
  id: string;
}

export interface RestoreCandidate {
  siteId: string;
  versionId: string;
  manifestPath: string;
  channel: "production" | "preview";
  status: "staged" | "published" | "failed";
  artifactsCollectedAt: Date | null;
  currentVersionId: string | null;
}

/** Why a restore of a version whose files the retention policy deleted fails. */
export const NO_LONGER_RESTORABLE_MESSAGE =
  "This version is no longer restorable. Its files were deleted after the retention period.";

export class DocsHistoryRepository {
  private readonly db;

  constructor(
    private readonly env: Parameters<typeof withDocsPublicationEffects>[1],
  ) {
    this.db = createDb(env);
  }

  async list(input: {
    userId: string;
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    page: DocsPublicationPage;
    manifestPaths: Map<string, string>;
  }> {
    const site = await this.ownedSite(input);

    if (!site) {
      throw new DocsContentError("not_found", "Docs site not found.");
    }

    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    const rows = await this.db
      .select({
        publication: schema.docsPublications,
        versionNumber: schema.docsVersions.versionNumber,
        versionStatus: schema.docsVersions.status,
        versionChannel: schema.docsVersions.channel,
        versionCollectedAt: schema.docsVersions.artifactsCollectedAt,
        manifestPath: schema.docsVersions.manifestPath,
        actorId: schema.user.id,
        actorName: schema.user.name,
      })
      .from(schema.docsPublications)
      .innerJoin(
        schema.docsVersions,
        and(
          eq(schema.docsVersions.id, schema.docsPublications.versionId),
          eq(schema.docsVersions.siteId, site.id),
        ),
      )
      .leftJoin(
        schema.user,
        eq(schema.user.id, schema.docsPublications.actorUserId),
      )
      .where(
        and(
          eq(schema.docsPublications.siteId, site.id),
          cursor
            ? or(
                lt(schema.docsPublications.createdAt, cursor.createdAt),
                and(
                  eq(schema.docsPublications.createdAt, cursor.createdAt),
                  lt(schema.docsPublications.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(schema.docsPublications.createdAt),
        desc(schema.docsPublications.id),
      )
      .limit(input.limit + 1);

    const pageRows = rows.slice(0, input.limit);
    const publications: DocsPublication[] = pageRows.map((row) => ({
      id: row.publication.id,
      kind: row.publication.kind,
      versionId: row.publication.versionId,
      versionNumber: row.versionNumber,
      actor:
        row.actorId && row.actorName
          ? { id: row.actorId, name: row.actorName }
          : null,
      branchName: row.publication.branchName,
      summary: docsPublicationSummarySchema.parse(row.publication.summary),
      agent: row.publication.agentClientName
        ? {
            clientName: row.publication.agentClientName,
            approvalRequestId: row.publication.approvalRequestId,
          }
        : null,
      createdAt: row.publication.createdAt.toISOString(),
      isCurrent: row.publication.versionId === site.publishedVersionId,
      canRestore: isRestorableVersion({
        channel: row.versionChannel,
        status: row.versionStatus,
        artifactsCollectedAt: row.versionCollectedAt,
        isCurrent: row.publication.versionId === site.publishedVersionId,
      }),
      noLongerRestorable: row.versionCollectedAt !== null,
    }));
    const last = pageRows.at(-1)?.publication;

    return {
      page: {
        publications,
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      },
      manifestPaths: new Map(
        pageRows.map((row) => [row.publication.id, row.manifestPath]),
      ),
    };
  }

  async getRestoreCandidate(input: {
    userId: string;
    projectId: string;
    publicationId: string;
  }): Promise<RestoreCandidate | null> {
    const site = await this.ownedSite(input);

    if (!site) {
      return null;
    }

    const [row] = await this.db
      .select({
        versionId: schema.docsVersions.id,
        manifestPath: schema.docsVersions.manifestPath,
        channel: schema.docsVersions.channel,
        status: schema.docsVersions.status,
        artifactsCollectedAt: schema.docsVersions.artifactsCollectedAt,
      })
      .from(schema.docsPublications)
      .innerJoin(
        schema.docsVersions,
        and(
          eq(schema.docsVersions.id, schema.docsPublications.versionId),
          eq(schema.docsVersions.siteId, site.id),
        ),
      )
      .where(
        and(
          eq(schema.docsPublications.id, input.publicationId),
          eq(schema.docsPublications.siteId, site.id),
        ),
      )
      .limit(1);

    return row
      ? {
          siteId: site.id,
          versionId: row.versionId,
          manifestPath: row.manifestPath,
          channel: row.channel,
          status: row.status,
          artifactsCollectedAt: row.artifactsCollectedAt,
          currentVersionId: site.publishedVersionId,
        }
      : null;
  }

  restore(input: {
    userId: string;
    projectId: string;
    publicationId: string;
    expectedMainVersionId: string;
    attribution?: PublicationAttribution;
    /** Warm-job ordering, sent with the post-commit hostname sync (M45). */
    warm?: DocsWarmHint;
  }): Promise<{ publicationId: string; versionId: string }> {
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
          throw new DocsContentError("not_found", "Docs site not found.");
        }

        const [site] = await tx
          .select()
          .from(schema.docsSites)
          .where(eq(schema.docsSites.id, owned.siteId))
          .for("update")
          .limit(1);

        if (!site || site.publishedVersionId !== input.expectedMainVersionId) {
          throw new DocsContentError(
            "main_changed",
            "Main changed. Load history again.",
          );
        }

        const [target] = await tx
          .select({
            versionId: schema.docsVersions.id,
            status: schema.docsVersions.status,
            channel: schema.docsVersions.channel,
            artifactsCollectedAt: schema.docsVersions.artifactsCollectedAt,
          })
          .from(schema.docsPublications)
          .innerJoin(
            schema.docsVersions,
            and(
              eq(schema.docsVersions.id, schema.docsPublications.versionId),
              eq(schema.docsVersions.siteId, site.id),
            ),
          )
          .where(
            and(
              eq(schema.docsPublications.id, input.publicationId),
              eq(schema.docsPublications.siteId, site.id),
            ),
          )
          .limit(1);

        if (!target) {
          throw new DocsContentError("not_found", "Publication not found.");
        }

        // The site row lock orders this check after a collector that is
        // marking the version as collected.
        if (target.artifactsCollectedAt !== null) {
          throw new DocsContentError(
            "invalid",
            NO_LONGER_RESTORABLE_MESSAGE,
          );
        }
        if (
          !isRestorableVersion({
            ...target,
            isCurrent: target.versionId === site.publishedVersionId,
          })
        ) {
          throw new DocsContentError(
            "invalid",
            "This publication cannot be restored.",
          );
        }

        await tx
          .update(schema.docsSites)
          .set({
            publishedVersionId: target.versionId,
            updatedAt: new Date(),
          })
          .where(eq(schema.docsSites.id, site.id));
        const publicationId = await recordPublication(tx, {
          siteId: site.id,
          versionId: target.versionId,
          previousVersionId: input.expectedMainVersionId,
          kind: "restore",
          actorUserId: input.userId,
          branchName: null,
          summary: { restoredPublicationId: input.publicationId },
          attribution: input.attribution,
        });

        await enqueue({ siteId: site.id });
        await enqueuePrerender({
          siteId: site.id,
          publishedVersionId: target.versionId,
          reason: "restore",
        });

        return { publicationId, versionId: target.versionId };
      },
      input.warm ? { warm: input.warm } : {},
    );
  }

  private async ownedSite(input: { userId: string; projectId: string }) {
    const [site] = await this.db
      .select({
        id: schema.docsSites.id,
        publishedVersionId: schema.docsSites.publishedVersionId,
      })
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

    return site ?? null;
  }
}

/**
 * A published production version can be restored while it is not current
 * and the retention policy has not deleted its files.
 */
export function isRestorableVersion(version: {
  channel: "production" | "preview";
  status: "staged" | "published" | "failed";
  artifactsCollectedAt: Date | null;
  isCurrent: boolean;
}): boolean {
  return (
    version.channel === "production" &&
    version.status === "published" &&
    version.artifactsCollectedAt === null &&
    !version.isCurrent
  );
}

function encodeCursor(cursor: Cursor): string {
  return btoa(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(encoded: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 300) {
      throw new Error("Invalid cursor");
    }

    const padded = encoded
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const value: unknown = JSON.parse(atob(padded));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("createdAt" in value) ||
      typeof value.createdAt !== "string" ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !z.uuid().safeParse(value.id).success ||
      !z.iso.datetime().safeParse(value.createdAt).success
    ) {
      throw new Error("Invalid cursor");
    }

    const createdAt = new Date(value.createdAt);

    if (!Number.isFinite(createdAt.getTime())) {
      throw new Error("Invalid cursor");
    }

    return { createdAt, id: value.id };
  } catch {
    throw new DocsContentError("invalid", "The history cursor is invalid.");
  }
}
