import { schema } from "@doxahq/db";
import {
  branchIdSchema,
  branchPathSchema,
  siteIdSchema,
  versionIdSchema,
  type BranchId,
  type SiteId,
  type VersionId,
} from "@doxahq/contracts/docs-branches";
import type { DocsContentEditOrigin } from "@doxahq/contracts";
import type { DocsBranchCreator } from "@doxahq/contracts/docs-branches";

export type DocsBranchPurpose =
  (typeof schema.docsBranches.$inferSelect)["purpose"];

export type StoredDocsBranch = {
  id: BranchId;
  siteId: SiteId;
  baseVersionId: VersionId;
  purpose: DocsBranchPurpose;
  revision: number;
  previewRevision: number | null;
  ownerUserId: string;
  createdFromBranchId: BranchId | null;
  createdBy: DocsBranchCreator;
  createdAt: Date;
  updatedAt: Date;
} & ({ kind: "named"; name: string } | { kind: "hidden"; name: null });

export type StoredNamedDocsBranch = StoredDocsBranch & {
  kind: "named";
  name: string;
};

export type StoredBranchChange = {
  branchId: BranchId;
  path: string;
  byteSize: number;
  updatedByUserId: string;
  origin: DocsContentEditOrigin;
  updatedAt: Date;
} & (
  | { kind: "upsert"; content: string; contentSha256: string }
  | { kind: "delete"; content: null; contentSha256: null }
);

export function toStoredBranch(
  row: typeof schema.docsBranches.$inferSelect,
): StoredDocsBranch {
  const common = {
    id: branchIdSchema.parse(row.id),
    siteId: siteIdSchema.parse(row.siteId),
    baseVersionId: versionIdSchema.parse(row.baseVersionId),
    purpose: row.purpose,
    revision: row.revision,
    previewRevision: row.previewRevision,
    ownerUserId: row.ownerUserId,
    createdFromBranchId: row.createdFromBranchId
      ? branchIdSchema.parse(row.createdFromBranchId)
      : null,
    createdBy: toCreator(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (row.kind === "hidden") {
    if (row.name !== null) {
      throw new Error("Hidden branch has a name");
    }

    return { ...common, kind: "hidden", name: null };
  }

  if (row.name === null) {
    throw new Error("Named branch has no name");
  }

  return { ...common, kind: "named", name: row.name };
}

function toCreator(
  row: Pick<
    typeof schema.docsBranches.$inferSelect,
    "createdByClientId" | "createdByClientName" | "createdByUserId"
  >,
): DocsBranchCreator {
  return row.createdByClientId && row.createdByClientName
    ? {
        kind: "agent",
        clientId: row.createdByClientId,
        clientName: row.createdByClientName,
        userId: row.createdByUserId,
      }
    : { kind: "user" };
}

/**
 * True when this client, acting for this member, created the branch. The
 * client ID alone is not enough: team members can share an OAuth client.
 * Mirrors the delete filter in eraseNamedBranch.
 */
export function isCreatedByAgent(
  creator: DocsBranchCreator,
  agent: { clientId: string; userId: string },
): boolean {
  return (
    creator.kind === "agent" &&
    creator.clientId === agent.clientId &&
    creator.userId === agent.userId
  );
}

/** The creator columns of a new branch row. */
export function creatorColumns(creator: DocsBranchCreator): {
  createdByClientId: string | null;
  createdByClientName: string | null;
  createdByUserId: string | null;
} {
  return creator.kind === "agent"
    ? {
        createdByClientId: creator.clientId,
        createdByClientName: creator.clientName,
        createdByUserId: creator.userId,
      }
    : { createdByClientId: null, createdByClientName: null, createdByUserId: null };
}

/** The origin of a stored branch change, which the column keeps as text. */
export function parseEditOrigin(origin: string): DocsContentEditOrigin {
  if (origin !== "editor" && origin !== "agent" && origin !== "mcp") {
    throw new Error("Invalid stored branch origin");
  }

  return origin;
}

export function toStoredChange(
  row: typeof schema.docsBranchChanges.$inferSelect,
): StoredBranchChange {
  if (!branchPathSchema.safeParse(row.path).success) {
    throw new Error("Invalid stored branch path");
  }

  const common = {
    branchId: branchIdSchema.parse(row.branchId),
    path: row.path,
    byteSize: row.byteSize,
    updatedByUserId: row.updatedByUserId,
    origin: parseEditOrigin(row.origin),
    updatedAt: row.updatedAt,
  };

  if (row.kind === "delete") {
    if (row.content !== null || row.contentSha256 !== null) {
      throw new Error("Invalid delete row");
    }

    return {
      ...common,
      kind: "delete",
      content: null,
      contentSha256: null,
    };
  }

  if (row.content === null || row.contentSha256 === null) {
    throw new Error("Invalid upsert row");
  }

  return {
    ...common,
    kind: "upsert",
    content: row.content,
    contentSha256: row.contentSha256,
  };
}
