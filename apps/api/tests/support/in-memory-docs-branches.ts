import {
  branchIdSchema,
  versionIdSchema,
} from "@doxahq/contracts/docs-branches";
import type {
  AuthorizedDocsSite,
  DocsBranchStore,
  BranchChangeWrite,
  StoredBranchChange,
  StoredDocsBranch,
} from "../../src/repositories/docs-branches";
import type {
  CreateNamedBranchResult,
  DocsBranchManagementStore,
  NamedBranchRecord,
  RenameNamedBranchResult,
} from "../../src/repositories/docs-branch-management";
import {
  isCreatedByAgent,
  type StoredNamedDocsBranch,
} from "../../src/repositories/docs-branch-records";

interface OwnedSite {
  userId: string;
  site: AuthorizedDocsSite;
}

export class InMemoryDocsBranchStore
  implements DocsBranchStore, DocsBranchManagementStore
{
  private readonly sites: OwnedSite[] = [];
  private readonly branches = new Map<string, StoredDocsBranch>();
  private readonly changes = new Map<string, StoredBranchChange[]>();
  private readonly versionPrefixes = new Map<string, string>();
  /** Storage entries that deleting a branch releases, keyed by branch ID. */
  readonly previewEntries = new Map<string, string>();
  /** Pending publish request IDs, keyed by branch ID. */
  readonly pendingPublishRequests = new Map<string, string>();
  private managementQueue = Promise.resolve();

  async listNamedBranches(input: {
    userId: string;
    projectId: string;
  }): Promise<NamedBranchRecord[] | null> {
    const site = await this.getSiteForUser(input);

    if (!site) {
      return null;
    }

    return [...this.branches.values()]
      .filter(
        (branch): branch is StoredNamedDocsBranch =>
          branch.kind === "named" &&
          branch.siteId === site.id &&
          branch.ownerUserId === input.userId,
      )
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .map((branch) => ({
        branch,
        changeCount: this.changes.get(branch.id)?.length ?? 0,
      }));
  }

  createNamedBranch(
    input: Parameters<DocsBranchManagementStore["createNamedBranch"]>[0],
  ): Promise<CreateNamedBranchResult> {
    return this.withManagementLock(async () => {
      const site = await this.getSiteForUser(input);

      if (!site) {
        return { status: "not_found" };
      }

      const namedBranches = [...this.branches.values()].filter(
        (branch) => branch.siteId === site.id && branch.kind === "named",
      );

      if (namedBranches.length >= input.maxBranches) {
        return { status: "limit_reached" };
      }

      if (namedBranches.some((branch) => branch.name === input.request.name)) {
        return { status: "name_taken" };
      }

      const source =
        input.request.from.kind === "branch"
          ? this.branches.get(input.request.from.branchId)
          : null;

      if (
        input.request.from.kind === "branch" &&
        (!source ||
          source.kind !== "named" ||
          source.siteId !== site.id ||
          source.ownerUserId !== input.userId)
      ) {
        return { status: "not_found" };
      }

      const now = new Date();
      const branch: StoredNamedDocsBranch = {
        id: branchIdSchema.parse(crypto.randomUUID()),
        siteId: site.id,
        kind: "named",
        purpose: "user",
        name: input.request.name,
        ownerUserId: input.userId,
        baseVersionId: source?.baseVersionId ?? site.mainVersionId,
        createdFromBranchId: source?.id ?? null,
        createdBy: input.createdBy,
        revision: 0,
        previewRevision: null,
        createdAt: now,
        updatedAt: now,
      };

      this.branches.set(branch.id, branch);

      const sourceChanges = source ? (this.changes.get(source.id) ?? []) : [];
      const copiedChanges = sourceChanges.map((change) => ({
        ...change,
        branchId: branch.id,
      }));

      if (copiedChanges.length > 0) {
        this.changes.set(branch.id, copiedChanges);
      }

      return {
        status: "created",
        record: { branch, changeCount: copiedChanges.length },
      };
    });
  }

  renameNamedBranch(
    input: Parameters<DocsBranchManagementStore["renameNamedBranch"]>[0],
  ): Promise<RenameNamedBranchResult> {
    return this.withManagementLock(async () => {
      const site = await this.getSiteForUser(input);
      const branch = this.branches.get(input.branchId);

      if (
        !site ||
        !branch ||
        branch.kind !== "named" ||
        branch.siteId !== site.id ||
        branch.ownerUserId !== input.userId
      ) {
        return { status: "not_found" };
      }

      const nameTaken = [...this.branches.values()].some(
        (candidate) =>
          candidate.id !== branch.id &&
          candidate.siteId === site.id &&
          candidate.kind === "named" &&
          candidate.name === input.request.name,
      );

      if (nameTaken) {
        return { status: "name_taken" };
      }

      const renamed = {
        ...branch,
        name: input.request.name,
        updatedAt: new Date(),
      };

      this.branches.set(branch.id, renamed);

      return {
        status: "renamed",
        record: {
          branch: renamed,
          changeCount: this.changes.get(branch.id)?.length ?? 0,
        },
      };
    });
  }

  eraseNamedBranch(
    input: Parameters<DocsBranchManagementStore["eraseNamedBranch"]>[0],
  ): ReturnType<DocsBranchManagementStore["eraseNamedBranch"]> {
    return this.withManagementLock(async () => {
      const site = await this.getSiteForUser(input);
      const branch = this.branches.get(input.branchId);

      if (
        !site ||
        !branch ||
        branch.kind !== "named" ||
        branch.siteId !== site.id ||
        branch.ownerUserId !== input.userId
      ) {
        return { status: "not_found" };
      }

      if (input.eraser.kind === "agent") {
        if (!isCreatedByAgent(branch.createdBy, input.eraser)) {
          return { status: "not_found" };
        }
        const requestId = this.pendingPublishRequests.get(branch.id);
        if (requestId) return { status: "publish_pending", requestId };
      }

      this.changes.delete(branch.id);
      this.branches.delete(branch.id);

      return {
        status: "erased",
        collectEntryIds: this.releasePreviewEntries(branch.id),
      };
    });
  }

  async synchronize(
    input: Parameters<DocsBranchStore["synchronize"]>[0],
  ): ReturnType<DocsBranchStore["synchronize"]> {
    const site = await this.getSiteForUser(input);
    if (!site) return "not_found";
    if (site.mainVersionId !== input.expectedMainVersionId)
      return "main_changed";
    const branch = this.branches.get(input.branchId);
    if (
      !branch ||
      branch.siteId !== site.id ||
      branch.ownerUserId !== input.userId
    )
      return "not_found";
    if (
      branch.revision !== input.expectedRevision ||
      branch.baseVersionId !== input.expectedBaseVersionId
    )
      return "revision_changed";
    const now = new Date();
    const previous = new Map(
      (this.changes.get(branch.id) ?? []).map((change) => [
        change.path,
        change,
      ]),
    );
    this.changes.set(
      branch.id,
      input.changes.map((change): StoredBranchChange => {
        const prior = previous.get(change.path);
        const retained =
          prior?.kind === change.kind &&
          (change.kind === "delete" ||
            (prior.contentSha256 === change.contentSha256 &&
              prior.content === change.content));
        const common = {
          branchId: branch.id,
          path: change.path,
          updatedByUserId: retained ? prior.updatedByUserId : input.userId,
          origin: retained ? prior.origin : ("editor" as const),
          updatedAt: retained ? prior.updatedAt : now,
        };
        return change.kind === "upsert"
          ? {
              ...common,
              kind: "upsert",
              content: change.content,
              contentSha256: change.contentSha256,
              byteSize: change.byteSize,
            }
          : {
              ...common,
              kind: "delete",
              content: null,
              contentSha256: null,
              byteSize: 0,
            };
      }),
    );
    this.branches.set(branch.id, {
      ...branch,
      baseVersionId: versionIdSchema.parse(input.expectedMainVersionId),
      revision: branch.revision + 1,
      updatedAt: now,
    });
    return "synchronized";
  }

  addSite(userId: string, site: AuthorizedDocsSite): void {
    this.sites.push({ userId, site });
    this.versionPrefixes.set(site.mainVersionId, site.mainArtifactPrefix);
  }

  addVersion(versionId: string, artifactPrefix: string): void {
    this.versionPrefixes.set(versionId, artifactPrefix);
  }

  setMainVersion(
    siteId: string,
    versionId: string,
    artifactPrefix: string,
    versionNumber: number,
  ): void {
    const owned = this.sites.find(({ site }) => site.id === siteId);
    if (!owned) throw new Error("Site not found");
    owned.site.mainVersionId = versionIdSchema.parse(versionId);
    owned.site.mainArtifactPrefix = artifactPrefix;
    owned.site.mainVersionNumber = versionNumber;
    this.addVersion(versionId, artifactPrefix);
  }

  async resolveForUser(
    input: Parameters<DocsBranchStore["resolveForUser"]>[0],
  ) {
    const site = await this.getSiteForUser(input);
    if (!site) return null;
    const branch = await this.getBranchForUser(input);
    if (input.branch !== "main" && !branch) return null;
    const baseArtifactPrefix = branch
      ? this.versionPrefixes.get(branch.baseVersionId)
      : site.mainArtifactPrefix;
    if (!baseArtifactPrefix) throw new Error("Branch base version is missing");
    return { site, branch, baseArtifactPrefix };
  }

  addBranch(branch: StoredDocsBranch): void {
    this.branches.set(branch.id, branch);
  }

  setChanges(branchId: string, changes: StoredBranchChange[]): void {
    this.changes.set(branchId, [...changes]);
  }

  async getSiteForUser(input: {
    userId: string;
    projectId: string;
  }): Promise<AuthorizedDocsSite | null> {
    return (
      this.sites.find(
        ({ userId, site }) =>
          userId === input.userId && site.projectId === input.projectId,
      )?.site ?? null
    );
  }

  async getBranchForUser(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<StoredDocsBranch | null> {
    const site = await this.getSiteForUser(input);
    if (!site) return null;
    for (const branch of this.branches.values()) {
      if (branch.siteId !== site.id || branch.ownerUserId !== input.userId)
        continue;
      if (input.branch === "main" && branch.kind === "hidden") return branch;
      if (input.branch === branch.id && branch.kind === "named") return branch;
    }
    return null;
  }

  async getOrCreateHiddenBranch(input: {
    userId: string;
    projectId: string;
  }): Promise<StoredDocsBranch | null> {
    const site = this.sites.find(
      ({ userId, site }) =>
        userId === input.userId && site.projectId === input.projectId,
    )?.site;
    if (!site) return null;
    const existing = [...this.branches.values()].find(
      (branch) =>
        branch.siteId === site.id &&
        branch.ownerUserId === input.userId &&
        branch.kind === "hidden",
    );
    if (existing) return existing;
    const now = new Date();
    const branch: StoredDocsBranch = {
      id: branchIdSchema.parse(crypto.randomUUID()),
      siteId: site.id,
      kind: "hidden",
      purpose: "user",
      name: null,
      ownerUserId: input.userId,
      baseVersionId: site.mainVersionId,
      createdFromBranchId: null,
      createdBy: { kind: "user" },
      revision: 0,
      previewRevision: null,
      createdAt: now,
      updatedAt: now,
    };
    this.addBranch(branch);
    return branch;
  }

  async listChanges(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<StoredBranchChange[]> {
    const branch = await this.getBranchForUser(input);
    return branch ? [...(this.changes.get(branch.id) ?? [])] : [];
  }

  async getBaseVersion(branchId: string) {
    const branch = this.branches.get(branchId);
    if (!branch) return null;
    const artifactPrefix = this.versionPrefixes.get(branch.baseVersionId);
    return artifactPrefix
      ? { versionId: branch.baseVersionId, artifactPrefix }
      : null;
  }

  async writeChanges(
    input: Parameters<DocsBranchStore["writeChanges"]>[0],
  ): ReturnType<DocsBranchStore["writeChanges"]> {
    const site = await this.getSiteForUser(input);
    const branch = this.branches.get(input.branchId);
    if (
      !site ||
      !branch ||
      branch.siteId !== site.id ||
      branch.ownerUserId !== input.userId
    )
      return "not_found";
    if (branch.revision !== input.expectedRevision) return "revision_changed";
    const rows = new Map(
      (this.changes.get(branch.id) ?? []).map((row) => [row.path, row]),
    );
    for (const change of input.changes) {
      if (change.kind === "reset") {
        rows.delete(change.path);
        continue;
      }
      rows.set(change.path, memoryChange(branch, input, change));
    }
    const values = [...rows.values()];
    if (values.length > 2000) return "too_many_changes";
    if (
      values.reduce((total, row) => total + row.byteSize, 0) >
      32 * 1024 * 1024
    )
      return "branch_too_large";
    this.changes.set(branch.id, values);
    this.branches.set(branch.id, {
      ...branch,
      revision: branch.revision + 1,
      updatedAt: new Date(),
    });
    return "written";
  }

  async discard(
    input: Parameters<DocsBranchStore["discard"]>[0],
  ): ReturnType<DocsBranchStore["discard"]> {
    const branch = await this.getBranchForUser(input);
    if (!branch) {
      return input.branch === "main"
        ? { revision: 0, collectEntryIds: [] }
        : null;
    }
    this.changes.delete(branch.id);
    if (branch.kind === "hidden") {
      this.branches.delete(branch.id);
      return {
        revision: branch.revision + 1,
        collectEntryIds: this.releasePreviewEntries(branch.id),
      };
    }
    this.branches.set(branch.id, {
      ...branch,
      revision: branch.revision + 1,
      updatedAt: new Date(),
    });
    return { revision: branch.revision + 1, collectEntryIds: [] };
  }

  private releasePreviewEntries(branchId: string): string[] {
    const entryId = this.previewEntries.get(branchId);
    this.previewEntries.delete(branchId);
    return entryId ? [entryId] : [];
  }

  private withManagementLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.managementQueue.then(operation, operation);

    this.managementQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

function memoryChange(
  branch: StoredDocsBranch,
  input: Parameters<DocsBranchStore["writeChanges"]>[0],
  change: Exclude<BranchChangeWrite, { kind: "reset" }>,
): StoredBranchChange {
  const common = {
    branchId: branch.id,
    path: change.path,
    updatedByUserId: input.userId,
    origin: input.origin,
    updatedAt: new Date(),
  };
  return change.kind === "upsert"
    ? { ...common, ...change }
    : {
        ...common,
        kind: "delete",
        content: null,
        contentSha256: null,
        byteSize: 0,
      };
}
