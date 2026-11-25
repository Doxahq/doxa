import type { DocsContentEditOrigin } from "@doxahq/contracts";
import {
  validateBranchName,
  type CreateDocsBranchInput,
  type DocsBranchCreator,
  type DocsBranchList,
  type NamedDocsBranch,
  type RenameDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import {
  createValidationIssue,
  type ValidationIssue,
} from "@doxahq/site-config";

import type {
  BranchAgentIdentity,
  DocsBranchManagementStore,
  EraseNamedBranchResult,
  NamedBranchRecord,
} from "../../repositories/docs-branch-management";
import { PlanLimitError } from "@doxahq/billing";
import { DocsContentError } from "../docs-content/errors";
import type { EntitlementsService } from "../entitlements";
import type { CollectStorageNow } from "../storage-gc/collect-now";

export class DocsBranchValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super("The branch request has validation errors.");
    this.name = "DocsBranchValidationError";
  }
}

export class DocsBranchManagement {
  constructor(
    private readonly branches: DocsBranchManagementStore,
    private readonly entitlements: EntitlementsService,
    private readonly collectStorage: CollectStorageNow,
  ) {}

  async list(input: {
    userId: string;
    projectId: string;
  }): Promise<DocsBranchList> {
    const [records, entitlements] = await Promise.all([
      this.branches.listNamedBranches(input),
      this.entitlements.getProjectEntitlements(input.projectId),
    ]);

    if (!records) {
      throw new DocsContentError("not_found", "Docs site not found.");
    }

    return {
      branches: records.map(toBranchDto),
      maxBranchesPerSite: entitlements.maxBranchesPerSite,
    };
  }

  /** `createdBy` defaults to the user: a branch from the dashboard. */
  async create(input: {
    userId: string;
    projectId: string;
    request: CreateDocsBranchInput;
    createdBy?: DocsBranchCreator;
  }): Promise<NamedDocsBranch> {
    validateName(input.request.name);

    const entitlements = await this.entitlements.getProjectEntitlements(
      input.projectId,
    );
    const result = await this.branches.createNamedBranch({
      userId: input.userId,
      projectId: input.projectId,
      request: input.request,
      createdBy: input.createdBy ?? { kind: "user" },
      maxBranches: entitlements.maxBranchesPerSite,
    });

    switch (result.status) {
      case "created":
        return toBranchDto(result.record);
      case "not_found":
        throw new DocsContentError("branch_not_found", "Branch not found.");
      case "name_taken":
        throw new DocsBranchValidationError([
          createValidationIssue("branch_name_taken", "/name"),
        ]);
      case "limit_reached":
        throw new PlanLimitError({
          key: "docs.branches_per_site",
          limit: entitlements.maxBranchesPerSite,
          used: result.used,
        });
    }
  }

  async rename(input: {
    userId: string;
    projectId: string;
    branchId: string;
    request: RenameDocsBranchInput;
  }): Promise<NamedDocsBranch> {
    validateName(input.request.name);

    const result = await this.branches.renameNamedBranch(input);

    switch (result.status) {
      case "renamed":
        return toBranchDto(result.record);
      case "not_found":
        throw new DocsContentError("branch_not_found", "Branch not found.");
      case "name_taken":
        throw new DocsBranchValidationError([
          createValidationIssue("branch_name_taken", "/name"),
        ]);
    }
  }

  async erase(input: {
    actor: { userId: string; origin: DocsContentEditOrigin };
    projectId: string;
    branchId: string;
  }): Promise<void> {
    if (input.actor.origin !== "editor") {
      throw new DocsContentError(
        "invalid",
        "Only a dashboard action can erase a branch.",
      );
    }

    const result = await this.branches.eraseNamedBranch({
      userId: input.actor.userId,
      projectId: input.projectId,
      branchId: input.branchId,
      eraser: { kind: "user" },
    });

    await this.finishErase(result);
  }

  /**
   * An agent deletes a branch that the same OAuth client created for the
   * same member. Any other branch answers "not found", so an agent cannot
   * tell that a user branch exists. A branch whose publish waits for a
   * decision is kept. `userId` is the project owner; `agent.userId` is the
   * member the agent acts for.
   */
  async eraseOwnedByAgent(input: {
    userId: string;
    projectId: string;
    branchId: string;
    agent: BranchAgentIdentity;
  }): Promise<void> {
    const result = await this.branches.eraseNamedBranch({
      userId: input.userId,
      projectId: input.projectId,
      branchId: input.branchId,
      eraser: { kind: "agent", ...input.agent },
    });

    await this.finishErase(result);
  }

  private async finishErase(result: EraseNamedBranchResult): Promise<void> {
    switch (result.status) {
      case "not_found":
        throw new DocsContentError("branch_not_found", "Branch not found.");
      case "publish_pending":
        throw new DocsContentError(
          "publish_pending",
          "This branch has a pending publish request. Cancel the request before you delete the branch.",
          { requestId: result.requestId },
        );
      case "erased":
        await this.collectStorage(result.collectEntryIds);
    }
  }
}

function validateName(name: string): void {
  const issues = validateBranchName(name);

  if (issues.length > 0) {
    throw new DocsBranchValidationError(issues);
  }
}

function toBranchDto(record: NamedBranchRecord): NamedDocsBranch {
  return {
    id: record.branch.id,
    kind: "named",
    name: record.branch.name,
    purpose: record.branch.purpose,
    baseVersionId: record.branch.baseVersionId,
    createdFromBranchId: record.branch.createdFromBranchId,
    createdBy: record.branch.createdBy,
    revision: record.branch.revision,
    changeCount: record.changeCount,
    createdAt: record.branch.createdAt.toISOString(),
    updatedAt: record.branch.updatedAt.toISOString(),
  };
}
