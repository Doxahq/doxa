import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import {
  branchRefSchema,
  siteIdSchema,
  versionIdSchema,
  type SiteId,
  type VersionId,
} from "@doxahq/contracts/docs-branches";
import type { DocsContentEditOrigin } from "@doxahq/contracts";
import {
  writeBranchChanges,
  discardBranch,
  synchronizeBranch,
} from "./docs-branch-writes";
import {
  getBranchBaseVersion,
  resolveAuthorizedBranch,
} from "./docs-branch-resolution";
import {
  toStoredBranch,
  toStoredChange,
  type StoredBranchChange,
  type StoredDocsBranch,
} from "./docs-branch-records";
import type { PageHrefMove } from "./generation-review-records";
import {
  createNamedBranch,
  eraseNamedBranch,
  listNamedBranches,
  renameNamedBranch,
  type DocsBranchManagementStore,
} from "./docs-branch-management";

export type {
  StoredBranchChange,
  StoredDocsBranch,
} from "./docs-branch-records";

export interface AuthorizedDocsSite {
  id: SiteId;
  projectId: string;
  projectName: string;
  projectSlug: string;
  mainVersionId: VersionId;
  mainVersionNumber: number;
  mainArtifactPrefix: string;
  mainCreatedAt: Date;
}

export interface AuthorizedBranchContext {
  site: AuthorizedDocsSite;
  branch: StoredDocsBranch | null;
  baseArtifactPrefix: string;
}

export interface DocsBranchStore {
  resolveForUser(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<AuthorizedBranchContext | null>;
  getSiteForUser(input: {
    userId: string;
    projectId: string;
  }): Promise<AuthorizedDocsSite | null>;
  getBranchForUser(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<StoredDocsBranch | null>;
  getOrCreateHiddenBranch(input: {
    userId: string;
    projectId: string;
  }): Promise<StoredDocsBranch | null>;
  listChanges(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<StoredBranchChange[]>;
  getBaseVersion(branchId: string): Promise<{
    versionId: VersionId;
    artifactPrefix: string;
  } | null>;
  writeChanges(input: {
    userId: string;
    projectId: string;
    branchId: string;
    expectedRevision: number;
    origin: DocsContentEditOrigin;
    changes: readonly BranchChangeWrite[];
    /**
     * The pages that the changes renamed or moved. A generation review on
     * the branch follows them in the same transaction.
     */
    hrefMoves?: readonly PageHrefMove[];
  }): Promise<
    | "written"
    | "revision_changed"
    | "not_found"
    | "too_many_changes"
    | "branch_too_large"
  >;
  /**
   * Clears a named branch, or deletes the hidden branch. Returns null when
   * the branch does not exist. `collectEntryIds` names the storage entries to
   * collect after the commit.
   */
  discard(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<{ revision: number; collectEntryIds: string[] } | null>;
  synchronize(input: {
    userId: string;
    projectId: string;
    branchId: string;
    expectedRevision: number;
    expectedBaseVersionId: string;
    expectedMainVersionId: string;
    changes: readonly Exclude<BranchChangeWrite, { kind: "reset" }>[];
  }): Promise<
    "synchronized" | "not_found" | "main_changed" | "revision_changed"
  >;
}

export type BranchChangeWrite =
  | {
      path: string;
      kind: "upsert";
      content: string;
      contentSha256: string;
      byteSize: number;
    }
  | { path: string; kind: "delete" }
  | { path: string; kind: "reset" };

export class DocsBranchesRepository
  implements DocsBranchStore, DocsBranchManagementStore
{
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async getSiteForUser(input: {
    userId: string;
    projectId: string;
  }): Promise<AuthorizedDocsSite | null> {
    const [row] = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.projects.id,
        projectName: schema.projects.name,
        projectSlug: schema.projects.slug,
        versionId: schema.docsVersions.id,
        versionNumber: schema.docsVersions.versionNumber,
        artifactPrefix: schema.docsVersions.artifactPrefix,
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
    if (!row) return null;
    return {
      id: siteIdSchema.parse(row.siteId),
      projectId: row.projectId,
      projectName: row.projectName,
      projectSlug: row.projectSlug,
      mainVersionId: versionIdSchema.parse(row.versionId),
      mainVersionNumber: row.versionNumber,
      mainArtifactPrefix: row.artifactPrefix,
      mainCreatedAt: row.createdAt,
    };
  }

  resolveForUser(
    input: Parameters<DocsBranchStore["resolveForUser"]>[0],
  ): ReturnType<DocsBranchStore["resolveForUser"]> {
    return resolveAuthorizedBranch(this.db, input);
  }

  async getBranchForUser(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<StoredDocsBranch | null> {
    if (!branchRefSchema.safeParse(input.branch).success) return null;
    const branchCondition =
      input.branch === "main"
        ? and(
            eq(schema.docsBranches.kind, "hidden"),
            eq(schema.docsBranches.ownerUserId, input.userId),
          )
        : and(
            eq(schema.docsBranches.id, input.branch),
            eq(schema.docsBranches.kind, "named"),
          );
    const [row] = await this.db
      .select({ branch: schema.docsBranches })
      .from(schema.projects)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsSites.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.docsBranches,
        eq(schema.docsBranches.siteId, schema.docsSites.id),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.userId, input.userId),
          eq(schema.docsBranches.ownerUserId, input.userId),
          branchCondition,
        ),
      )
      .limit(1);
    return row ? toStoredBranch(row.branch) : null;
  }

  async getOrCreateHiddenBranch(input: {
    userId: string;
    projectId: string;
  }): Promise<StoredDocsBranch | null> {
    return this.db.transaction(async (tx) => {
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
      if (!owned) return null;

      const [site] = await tx
        .select()
        .from(schema.docsSites)
        .where(eq(schema.docsSites.id, owned.siteId))
        .for("update")
        .limit(1);
      if (!site?.publishedVersionId) return null;

      await tx
        .insert(schema.docsBranches)
        .values({
          siteId: site.id,
          kind: "hidden",
          name: null,
          ownerUserId: input.userId,
          baseVersionId: site.publishedVersionId,
        })
        .onConflictDoNothing();

      const [branch] = await tx
        .select()
        .from(schema.docsBranches)
        .where(
          and(
            eq(schema.docsBranches.siteId, site.id),
            eq(schema.docsBranches.kind, "hidden"),
            eq(schema.docsBranches.ownerUserId, input.userId),
          ),
        )
        .limit(1);
      if (!branch)
        throw new Error("Hidden branch insert did not produce a row");
      return toStoredBranch(branch);
    });
  }

  async listChanges(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<StoredBranchChange[]> {
    if (!branchRefSchema.safeParse(input.branch).success) return [];
    const branchCondition =
      input.branch === "main"
        ? eq(schema.docsBranches.kind, "hidden")
        : and(
            eq(schema.docsBranches.id, input.branch),
            eq(schema.docsBranches.kind, "named"),
          );
    const rows = await this.db
      .select({ change: schema.docsBranchChanges })
      .from(schema.projects)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsSites.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.docsBranches,
        eq(schema.docsBranches.siteId, schema.docsSites.id),
      )
      .innerJoin(
        schema.docsBranchChanges,
        eq(schema.docsBranchChanges.branchId, schema.docsBranches.id),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.userId, input.userId),
          eq(schema.docsBranches.ownerUserId, input.userId),
          branchCondition,
        ),
      );
    return rows.map(({ change }) => toStoredChange(change));
  }

  getBaseVersion(
    branchId: string,
  ): ReturnType<DocsBranchStore["getBaseVersion"]> {
    return getBranchBaseVersion(this.db, branchId);
  }

  writeChanges(
    input: Parameters<DocsBranchStore["writeChanges"]>[0],
  ): ReturnType<DocsBranchStore["writeChanges"]> {
    return writeBranchChanges(this.db, input);
  }

  discard(
    input: Parameters<DocsBranchStore["discard"]>[0],
  ): ReturnType<DocsBranchStore["discard"]> {
    return discardBranch(this.db, input);
  }

  synchronize(
    input: Parameters<DocsBranchStore["synchronize"]>[0],
  ): ReturnType<DocsBranchStore["synchronize"]> {
    return synchronizeBranch(this.db, input);
  }

  listNamedBranches(
    input: Parameters<DocsBranchManagementStore["listNamedBranches"]>[0],
  ): ReturnType<DocsBranchManagementStore["listNamedBranches"]> {
    return listNamedBranches(this.db, input);
  }

  createNamedBranch(
    input: Parameters<DocsBranchManagementStore["createNamedBranch"]>[0],
  ): ReturnType<DocsBranchManagementStore["createNamedBranch"]> {
    return createNamedBranch(this.db, input);
  }

  renameNamedBranch(
    input: Parameters<DocsBranchManagementStore["renameNamedBranch"]>[0],
  ): ReturnType<DocsBranchManagementStore["renameNamedBranch"]> {
    return renameNamedBranch(this.db, input);
  }

  eraseNamedBranch(
    input: Parameters<DocsBranchManagementStore["eraseNamedBranch"]>[0],
  ): ReturnType<DocsBranchManagementStore["eraseNamedBranch"]> {
    return eraseNamedBranch(this.db, input);
  }
}
