import { prepareDocsAsset } from "@doxahq/api/services/docs-branches/assets/asset-content";
import { assetBaseName } from "@doxahq/api/services/docs-branches/assets/asset-name";
import type { DocsContentEdit } from "@doxahq/contracts";
import {
  validateBranchName,
  type CreateDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import type { BranchServices } from "../../src/services/mcp-services";
import { isCreatedByAgent } from "@doxahq/api/repositories/docs-branch-records";
import { DocsBranchValidationError } from "@doxahq/api/services/docs-branches/management";
import { PlanLimitError } from "@doxahq/api/services/billing/mcp-billing";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import { validateConfigForSite } from "@doxahq/api/services/docs-content/site-config";
import type {
  ApplyEditsOptions,
  DocsContentActor,
} from "@doxahq/api/services/docs-content/service";
import { freePlanEntitlements } from "@doxahq/api/services/free-plan-entitlements";
import {
  BRANCH_ID,
  branchDiff,
  branchList,
  CREATED_AT,
  SITE_ID,
  VERSION_ID,
  working,
} from "./fixtures";

/** The branch revision the fakes report before a write. */
export const CURRENT_REVISION = 2;
/** A name that makes the fake `create` hit the branch limit. */
export const LIMIT_BRANCH_NAME = "agent-over-limit";

export interface AppliedEdits {
  actor: DocsContentActor;
  projectId: string;
  branch: string;
  edits: readonly DocsContentEdit[];
}

export function assertKnownBranch(branch: string): void {
  if (branch !== BRANCH_ID) {
    throw new DocsContentError("branch_not_found", "Branch not found.");
  }
}

/**
 * Mirrors `applyEdits`: the revision check, the site settings validation
 * (with the real validator), and dry runs. Only a real write is recorded.
 */
export async function fakeApplyEdits(
  written: AppliedEdits[],
  call: AppliedEdits,
  options: ApplyEditsOptions = {},
) {
  assertKnownBranch(call.branch);
  const { expectedRevision } = options;
  if (expectedRevision !== undefined && expectedRevision !== CURRENT_REVISION) {
    throw new DocsContentError("conflict", "Stale revision.", {
      currentRevision: CURRENT_REVISION,
    });
  }
  for (const edit of call.edits) {
    if (edit.type !== "set_site_config") continue;
    await validateConfigForSite(
      edit.config,
      { projectId: call.projectId, siteId: SITE_ID },
      freePlanEntitlements,
      { head: async () => null },
    );
  }
  if (options.dryRun) return working(CURRENT_REVISION);
  written.push(call);
  return working(CURRENT_REVISION + 1);
}

type BranchWrites = Omit<BranchServices, "list" | "getStatus">;

export function fakeBranchWrites(
  record: (method: string, userId: string, projectId: string) => void,
): BranchWrites {
  return {
    async create(input) {
      record("branches.create", input.userId, input.projectId);
      return { ...createBranch(input.request), createdBy: input.createdBy };
    },
    // Mirrors the creator filter of the SQL erase: a branch of the user, of
    // another client, or of another member on the same client is "not found".
    async deleteOwn(input) {
      record("branches.deleteOwn", input.userId, input.projectId);
      const branch = branchList().branches.find(
        (candidate) => candidate.id === input.branchId,
      );
      if (
        branch?.kind !== "named" ||
        !isCreatedByAgent(branch.createdBy, input.agent)
      ) {
        throw new DocsContentError("branch_not_found", "Branch not found.");
      }
    },
    async diff(input) {
      record("branches.diff", input.userId, input.projectId);
      assertKnownBranch(input.branch);
      return branchDiff();
    },
    async previewSync(input) {
      record("branches.previewSync", input.userId, input.projectId);
      assertKnownBranch(input.branch);
      return {
        mainVersionId: VERSION_ID,
        behind: true,
        conflicts: [],
        autoResolvedCount: 0,
      };
    },
    async synchronize(input) {
      record("branches.synchronize", input.userId, input.projectId);
      assertKnownBranch(input.branch);
      if (input.request.expectedMainVersionId !== VERSION_ID) {
        throw new DocsContentError("main_changed", "Main changed.");
      }
      return { revision: CURRENT_REVISION + 1, changeCount: 1 };
    },
    async buildPreview(input) {
      record("branches.buildPreview", input.userId, input.projectId);
      assertKnownBranch(input.branch);
      return {
        url: "http://preview-agent.localhost:3002",
        hostname: "preview-agent.localhost",
        versionId: VERSION_ID,
      };
    },
    // Runs the real type check and name slug; storage has its own tests.
    async uploadAsset(input) {
      record("branches.uploadAsset", input.userId, input.projectId);
      assertKnownBranch(input.branch);
      const prepared = prepareDocsAsset(input.bytes);
      return {
        path: `/assets/${assetBaseName(input.fileName)}.${prepared.extension}`,
        contentType: prepared.contentType,
        size: prepared.bytes.byteLength,
        sanitized: prepared.sanitized,
        reused: false,
        revision: CURRENT_REVISION + 1,
      };
    },
  };
}

function createBranch(request: CreateDocsBranchInput) {
  const issues = validateBranchName(request.name);
  if (issues.length > 0) throw new DocsBranchValidationError(issues);
  if (request.name === LIMIT_BRANCH_NAME) {
    throw new PlanLimitError({ key: "docs.branches_per_site", limit: 2, used: 2 });
  }
  const [existing] = branchList().branches;
  if (!existing || existing.kind !== "named") throw new Error("No fixture.");
  return {
    ...existing,
    name: request.name,
    revision: 0,
    changeCount: 0,
    createdFromBranchId:
      request.from.kind === "branch" ? request.from.branchId : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}
