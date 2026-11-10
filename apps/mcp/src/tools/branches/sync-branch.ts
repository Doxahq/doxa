import {
  docsSyncPreviewSchema,
  syncDocsBranchInputSchema,
  type SyncDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import { HintedToolError } from "../../errors";
import { defineMcpTool } from "../../tool-definition";
import {
  namedBranchInput,
  projectIdInput,
  requireNamedBranch,
  writeAnnotations,
} from "../shared";
import { OWN_BRANCH_ONLY, requireOwnBranch } from "./branch-ownership";
import { liveBranchId } from "../../live-activity";

const MAX_RESOLUTIONS = 500;
const syncFields = syncDocsBranchInputSchema.shape;

export const syncBranchTool = defineMcpTool({
  name: "sync_branch",
  title: "Sync branch",
  description:
    `Brings a branch up to date with the latest published main. With dryRun true (the default) it only reports whether the branch is behind and which changes conflict. To apply, call it again with dryRun false, expectedMainVersionId set to the mainVersionId of the dry run, and one resolution for each conflict: "mine" keeps the branch change, "main" takes the published one. ${OWN_BRANCH_ONLY}`,
  scope: "docs:write",
  cost: "write",
  annotations: writeAnnotations(false),
  input: z
    .object({
      projectId: projectIdInput,
      branch: namedBranchInput,
      dryRun: z.boolean().default(true),
      expectedMainVersionId: syncFields.expectedMainVersionId
        .optional()
        .describe("The mainVersionId from the dry run. Needed to apply."),
      resolutions: syncFields.resolutions.max(MAX_RESOLUTIONS).default([]),
      defaultResolution: syncFields.defaultResolution.describe(
        "The resolution for every conflict that resolutions does not list.",
      ),
    })
    .strict(),
  output: z
    .object({
      dryRun: z.boolean(),
      preview: docsSyncPreviewSchema.optional(),
      synchronized: z
        .object({
          revision: z.number().int().nonnegative(),
          changeCount: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  describeActivity: (input) =>
    input.dryRun ? [] : [{ kind: "branch", branchId: liveBranchId(input.branch) }],
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    const scope = { userId: authorized.ownerUserId, projectId: authorized.projectId };
    const { branches } = context.services;
    if (input.dryRun) {
      // A dry run only reads, so it works on any branch.
      const branch = requireNamedBranch(input.branch);
      return { dryRun: true, preview: await branches.previewSync({ ...scope, branch }) };
    }
    const request = syncRequest(input);
    const branch = await requireOwnBranch(context, authorized, input.branch);
    return {
      dryRun: false,
      synchronized: await branches.synchronize({ ...scope, branch, request }),
    };
  },
});

function syncRequest(input: {
  expectedMainVersionId?: string;
  resolutions: SyncDocsBranchInput["resolutions"];
  defaultResolution?: SyncDocsBranchInput["defaultResolution"];
}): SyncDocsBranchInput {
  if (!input.expectedMainVersionId) {
    throw new HintedToolError(
      new DocsContentError(
        "invalid",
        "expectedMainVersionId is required when dryRun is false.",
      ),
      "Call sync_branch with dryRun true, then pass its mainVersionId.",
    );
  }
  return {
    expectedMainVersionId: input.expectedMainVersionId,
    resolutions: input.resolutions,
    ...(input.defaultResolution
      ? { defaultResolution: input.defaultResolution }
      : {}),
  };
}
