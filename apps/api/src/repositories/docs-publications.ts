import { and, eq, inArray } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";
import {
  docsPublicationSummarySchema,
  type DocsPublicationKind,
  type DocsPublicationSummary,
} from "@doxahq/contracts/docs-branches";
import type { DocsMutationTransaction } from "./docs-cache-invalidations";
import { retireDocsVersion } from "./docs-version-retirement";

/** Who published, when an agent did. Stored on the publication row. */
export interface PublicationAttribution {
  agentClientId: string;
  agentClientName: string;
  approvalRequestId?: string | null;
}

export interface RecordPublicationInput {
  siteId: string;
  versionId: string;
  previousVersionId: string | null;
  kind: DocsPublicationKind;
  actorUserId: string | null;
  branchName: string | null;
  summary: DocsPublicationSummary;
  attribution?: PublicationAttribution | null;
}

export interface DocsPublicationStore {
  record(
    tx: DocsMutationTransaction,
    input: RecordPublicationInput,
  ): Promise<string>;
}

export class DocsPublicationsRepository implements DocsPublicationStore {
  async record(
    tx: DocsMutationTransaction,
    input: RecordPublicationInput,
  ): Promise<string> {
    return recordPublication(tx, input);
  }
}

/**
 * A publication row must commit with the pointer move that it describes. The
 * same transaction queues the replaced version for collection.
 */
export async function recordPublication(
  tx: DocsMutationTransaction,
  input: RecordPublicationInput,
): Promise<string> {
  const summary = docsPublicationSummarySchema.parse(input.summary);
  const [version] = await tx
    .select({ id: schema.docsVersions.id })
    .from(schema.docsVersions)
    .where(
      and(
        eq(schema.docsVersions.id, input.versionId),
        eq(schema.docsVersions.siteId, input.siteId),
      ),
    )
    .limit(1);
  if (!version)
    throw new Error("Publication version does not belong to the site");

  if (input.previousVersionId) {
    const [previous] = await tx
      .select({ id: schema.docsVersions.id })
      .from(schema.docsVersions)
      .where(
        and(
          eq(schema.docsVersions.id, input.previousVersionId),
          eq(schema.docsVersions.siteId, input.siteId),
        ),
      )
      .limit(1);
    if (!previous)
      throw new Error(
        "Previous publication version does not belong to the site",
      );
  }

  const [publication] = await tx
    .insert(schema.docsPublications)
    .values({
      siteId: input.siteId,
      versionId: input.versionId,
      previousVersionId: input.previousVersionId,
      kind: input.kind,
      actorUserId: input.actorUserId,
      branchName: input.branchName,
      summary,
      agentClientId: input.attribution?.agentClientId ?? null,
      agentClientName: input.attribution?.agentClientName ?? null,
      approvalRequestId: input.attribution?.approvalRequestId ?? null,
    })
    .returning({ id: schema.docsPublications.id });
  if (!publication) throw new Error("Publication insert returned no row");
  if (input.previousVersionId && input.previousVersionId !== input.versionId) {
    // The replaced version leaves production. The retention policy keeps it
    // restorable for a while; the collector decides when its storage goes.
    await retireDocsVersion(
      tx,
      { siteId: input.siteId, versionId: input.previousVersionId },
      "production_replaced",
    );
  }
  return publication.id;
}

/**
 * True when a person published content on the site: an editor publication or
 * an import. A generation over such a site replaces hand-written pages.
 */
export async function hasHandWrittenPublication(
  db: DoxaDb | DocsMutationTransaction,
  siteId: string,
): Promise<boolean> {
  const [publication] = await db
    .select({ id: schema.docsPublications.id })
    .from(schema.docsPublications)
    .where(
      and(
        eq(schema.docsPublications.siteId, siteId),
        inArray(schema.docsPublications.kind, ["editor", "import"]),
      ),
    )
    .limit(1);

  return Boolean(publication);
}

/**
 * True when the site has exactly one publication from a branch or a review:
 * the one just made. A starter, an import or a restore does not count.
 */
export async function isFirstBranchPublication(db: DoxaDb, siteId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.docsPublications.id })
    .from(schema.docsPublications)
    .where(
      and(
        eq(schema.docsPublications.siteId, siteId),
        inArray(schema.docsPublications.kind, ["editor", "generation"]),
      ),
    )
    .limit(2);

  return rows.length === 1;
}
