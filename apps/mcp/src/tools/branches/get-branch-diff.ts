import {
  DOCS_BRANCH_DIFF_MAX_LINES,
  docsBranchDiffSchema,
} from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import { HintedToolError } from "../../errors";
import { defineMcpTool } from "../../tool-definition";
import {
  namedBranchInput,
  projectIdInput,
  READ_ONLY_ANNOTATIONS,
} from "../shared";
import { liveBranchId } from "../../live-activity";

export const getBranchDiffTool = defineMcpTool({
  name: "get_branch_diff",
  title: "Get branch diff",
  description: `Shows what publishing a branch changes: the added, edited, and deleted pages with titles and hrefs, the navigation and page list changes, and the site settings change. Each file has a unified diff against the branch base, cut after ${DOCS_BRANCH_DIFF_MAX_LINES} lines (truncated: true; call read_page for the full page). Call it before publish_branch to check your work. behind: true means main changed since the branch base; call sync_branch first.`,
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z
    .object({ projectId: projectIdInput, branch: namedBranchInput })
    .strict(),
  output: docsBranchDiffSchema,
  describeActivity: (input) => [
    { kind: "read", branchId: liveBranchId(input.branch), detail: "Branch changes" },
  ],
  async run(context, input) {
    if (input.branch === "main") {
      throw new HintedToolError(
        new DocsContentError("invalid", "Main is the live site; it has no diff."),
        "Pass a branch ID from list_branches.",
      );
    }
    const authorized = await context.authorize(input.projectId, "docs.read");
    return context.services.branches.diff({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      branch: input.branch,
    });
  },
});
