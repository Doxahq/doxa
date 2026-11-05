import type { DocsContentEditOrigin } from "@doxahq/contracts";
import type {
  CreateDocsBranchInput,
  DocsBranchCreator,
  DocsBranchList,
  DocsConflict,
  DocsConflictDiff,
  DocsSyncPreview,
  NamedDocsBranch,
  RenameDocsBranchInput,
  SyncDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import type { Env } from "../../env";
import type {
  BranchAgentIdentity,
  DocsBranchManagementStore,
} from "../../repositories/docs-branch-management";
import {
  DocsBranchesRepository,
  type DocsBranchStore,
} from "../../repositories/docs-branches";
import { DocsContentError } from "../docs-content/errors";
import type { EntitlementsService } from "../entitlements";
import { createEntitlements } from "../free-plan-entitlements";
import {
  createR2DocsContentStore,
  type DocsContentStore,
  withRequestReadCache,
} from "../docs-content/store";
import {
  createCollectStorageNow,
  type CollectStorageNow,
} from "../storage-gc/collect-now";
import { DocsBranchManagement } from "./management";
import { DocsBranchSync } from "./sync";

interface SyncDependencies {
  branches: Pick<
    DocsBranchStore,
    "resolveForUser" | "listChanges" | "synchronize"
  >;
  store: DocsContentStore;
}

interface ManagementDependencies {
  branches: DocsBranchManagementStore;
  entitlements: EntitlementsService;
}

export interface DocsBranchServiceDependencies {
  branches: Pick<DocsBranchStore, "discard">;
  collectStorage: CollectStorageNow;
  sync?: SyncDependencies;
  management?: ManagementDependencies;
}

export class DocsBranchService {
  constructor(private readonly deps: DocsBranchServiceDependencies) {}

  static fromEnv(env: Env): DocsBranchService {
    const branches = new DocsBranchesRepository(env);

    return new DocsBranchService({
      branches,
      collectStorage: createCollectStorageNow(env),
      sync: {
        branches,
        store: withRequestReadCache(
          createR2DocsContentStore(env.DOCS_BUCKET),
        ),
      },
      management: {
        branches,
        entitlements: createEntitlements(env),
      },
    });
  }

  list(input: { userId: string; projectId: string }): Promise<DocsBranchList> {
    return this.management().list(input);
  }

  create(input: {
    userId: string;
    projectId: string;
    request: CreateDocsBranchInput;
    createdBy?: DocsBranchCreator;
  }): Promise<NamedDocsBranch> {
    return this.management().create(input);
  }

  rename(input: {
    userId: string;
    projectId: string;
    branchId: string;
    request: RenameDocsBranchInput;
  }): Promise<NamedDocsBranch> {
    return this.management().rename(input);
  }

  erase(input: {
    actor: { userId: string; origin: DocsContentEditOrigin };
    projectId: string;
    branchId: string;
  }): Promise<void> {
    return this.management().erase(input);
  }

  eraseOwnedByAgent(input: {
    userId: string;
    projectId: string;
    branchId: string;
    agent: BranchAgentIdentity;
  }): Promise<void> {
    return this.management().eraseOwnedByAgent(input);
  }

  async discard(input: {
    actor: { userId: string; origin: DocsContentEditOrigin };
    projectId: string;
    branch: string;
  }): Promise<{ revision: number }> {
    if (input.actor.origin !== "editor") {
      throw new DocsContentError(
        "invalid",
        "Only a dashboard action can discard a branch.",
      );
    }

    const discarded = await this.deps.branches.discard({
      userId: input.actor.userId,
      projectId: input.projectId,
      branch: input.branch,
    });

    if (discarded === null) {
      throw new DocsContentError("branch_not_found", "Branch not found.");
    }

    await this.deps.collectStorage(discarded.collectEntryIds);

    return { revision: discarded.revision };
  }

  previewSync(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<DocsSyncPreview> {
    return this.sync().preview(input);
  }

  synchronize(input: {
    userId: string;
    projectId: string;
    branch: string;
    request: SyncDocsBranchInput;
  }): Promise<{ revision: number; changeCount: number }> {
    return this.sync().synchronize(input);
  }

  diffSync(input: {
    userId: string;
    projectId: string;
    branch: string;
    key: DocsConflict["key"];
  }): Promise<DocsConflictDiff> {
    return this.sync().diff(input);
  }

  private sync(): DocsBranchSync {
    if (!this.deps.sync) {
      throw new Error("A docs content store is required for synchronization.");
    }

    return new DocsBranchSync(this.deps.sync.branches, this.deps.sync.store);
  }

  private management(): DocsBranchManagement {
    if (!this.deps.management) {
      throw new Error("Branch management dependencies are required.");
    }

    return new DocsBranchManagement(
      this.deps.management.branches,
      this.deps.management.entitlements,
      this.deps.collectStorage,
    );
  }
}
