import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema, type DoxaDb } from "@doxahq/db";
import {
  branchRefSchema,
  siteIdSchema,
  versionIdSchema,
} from "@doxahq/contracts/docs-branches";
import { toStoredBranch } from "./docs-branch-records";
import type { AuthorizedBranchContext, DocsBranchStore } from "./docs-branches";

export async function getBranchBaseVersion(
  db: DoxaDb,
  branchId: string,
): ReturnType<DocsBranchStore["getBaseVersion"]> {
  const [row] = await db
    .select({
      versionId: schema.docsVersions.id,
      artifactPrefix: schema.docsVersions.artifactPrefix,
    })
    .from(schema.docsBranches)
    .innerJoin(
      schema.docsVersions,
      eq(schema.docsVersions.id, schema.docsBranches.baseVersionId),
    )
    .where(eq(schema.docsBranches.id, branchId))
    .limit(1);
  return row
    ? {
        versionId: versionIdSchema.parse(row.versionId),
        artifactPrefix: row.artifactPrefix,
      }
    : null;
}

/** Authorize the project, site, branch, and base version in one read. */
export async function resolveAuthorizedBranch(
  db: DoxaDb,
  input: Parameters<DocsBranchStore["resolveForUser"]>[0],
): ReturnType<DocsBranchStore["resolveForUser"]> {
  const parsed = branchRefSchema.safeParse(input.branch);

  if (!parsed.success) {
    return null;
  }

  const baseVersion = alias(schema.docsVersions, "branch_base_version");
  const branchCondition =
    parsed.data === "main"
      ? and(
          eq(schema.docsBranches.kind, "hidden"),
          eq(schema.docsBranches.ownerUserId, input.userId),
        )
      : and(
          eq(schema.docsBranches.id, parsed.data),
          eq(schema.docsBranches.kind, "named"),
          eq(schema.docsBranches.ownerUserId, input.userId),
        );
  const [row] = await db
    .select({
      siteId: schema.docsSites.id,
      projectId: schema.projects.id,
      projectName: schema.projects.name,
      projectSlug: schema.projects.slug,
      mainVersionId: schema.docsVersions.id,
      mainVersionNumber: schema.docsVersions.versionNumber,
      mainArtifactPrefix: schema.docsVersions.artifactPrefix,
      mainCreatedAt: schema.docsVersions.createdAt,
      branch: schema.docsBranches,
      baseArtifactPrefix: baseVersion.artifactPrefix,
    })
    .from(schema.projects)
    .innerJoin(
      schema.docsSites,
      eq(schema.docsSites.projectId, schema.projects.id),
    )
    .innerJoin(
      schema.docsVersions,
      and(
        eq(schema.docsVersions.id, schema.docsSites.publishedVersionId),
        eq(schema.docsVersions.siteId, schema.docsSites.id),
      ),
    )
    .leftJoin(
      schema.docsBranches,
      and(eq(schema.docsBranches.siteId, schema.docsSites.id), branchCondition),
    )
    .leftJoin(
      baseVersion,
      and(
        eq(baseVersion.id, schema.docsBranches.baseVersionId),
        eq(baseVersion.siteId, schema.docsSites.id),
      ),
    )
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, input.userId),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const branch = row.branch ? toStoredBranch(row.branch) : null;

  if (parsed.data !== "main" && !branch) {
    return null;
  }

  if (branch && !row.baseArtifactPrefix) {
    throw new Error("Branch base version is missing");
  }

  return {
    site: {
      id: siteIdSchema.parse(row.siteId),
      projectId: row.projectId,
      projectName: row.projectName,
      projectSlug: row.projectSlug,
      mainVersionId: versionIdSchema.parse(row.mainVersionId),
      mainVersionNumber: row.mainVersionNumber,
      mainArtifactPrefix: row.mainArtifactPrefix,
      mainCreatedAt: row.mainCreatedAt,
    },
    branch,
    baseArtifactPrefix: row.baseArtifactPrefix ?? row.mainArtifactPrefix,
  };
}
