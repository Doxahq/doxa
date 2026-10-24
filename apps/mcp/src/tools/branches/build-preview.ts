import { docsBranchPreviewResultSchema } from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import {
  namedBranchInput,
  projectIdInput,
  requireNamedBranch,
  writeAnnotations,
} from "../shared";

export const buildPreviewTool = defineMcpTool({
  name: "build_preview",
  title: "Build preview",
  description:
    "Builds a preview site of a branch and returns its URL. Give the URL to the user so they can review the changes before publishing. A build takes a few seconds and is rate limited; build again only after new edits.",
  scope: "docs:write",
  cost: "expensive",
  annotations: writeAnnotations(true),
  input: z
    .object({ projectId: projectIdInput, branch: namedBranchInput })
    .strict(),
  output: docsBranchPreviewResultSchema,
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    return context.services.branches.buildPreview({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      branch: requireNamedBranch(input.branch),
    });
  },
});
