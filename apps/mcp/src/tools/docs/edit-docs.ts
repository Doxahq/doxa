import { docsContentWorkingSchema } from "@doxahq/contracts";
import { validationIssueSchema } from "@doxahq/contracts/validation";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import {
  agentNoteInput,
  expectedRevisionInput,
  namedBranchInput,
  projectIdInput,
  requireNamedBranch,
  writeAnnotations,
} from "../shared";
import {
  assertNoMdxIssues,
  contentEditIssues,
  contentEditSchema,
} from "./content-edits";
import { docsActorFor } from "./docs-actor";
import { OWN_BRANCH_ONLY, requireOwnBranch } from "../branches/branch-ownership";
import { liveBranchId } from "../../live-activity";
import { describeDocsEdits } from "./edit-activity";

const MAX_EDITS = 50;

export const editDocsTool = defineMcpTool({
  name: "edit_docs",
  title: "Edit docs",
  description:
    `Applies 1 to 50 edits to a named branch in one step: page content, creating, renaming, moving, or deleting pages, groups, and sections, and page icons. The edits apply in order and all succeed or none do. create_group adds an empty group; a create_page with its groupIndex later in the same call gives it its first page. Every page source must parse as MDX (see doxa://reference/mdx). With dryRun true the edits are checked and nothing is written: ok and issues report MDX problems, and other problems fail the call as they would on a real run. Use update_site_settings for site settings. ${OWN_BRANCH_ONLY}`,
  scope: "docs:write",
  cost: "write",
  annotations: writeAnnotations(false),
  input: z
    .object({
      projectId: projectIdInput,
      branch: namedBranchInput,
      edits: z.array(contentEditSchema).min(1).max(MAX_EDITS),
      expectedRevision: expectedRevisionInput,
      note: agentNoteInput,
      dryRun: z.boolean().default(false),
    })
    .strict(),
  output: z
    .object({
      dryRun: z.boolean(),
      ok: z.boolean(),
      issues: z.array(validationIssueSchema),
      working: docsContentWorkingSchema.nullable(),
    })
    .strict(),
  describeActivity: (input, output, pageChanges) =>
    input.dryRun
      ? []
      : describeDocsEdits(
          input.edits,
          {
            branchId: liveBranchId(input.branch),
            note: input.note ?? null,
            branchRevision: output.working?.revision ?? null,
          },
          pageChanges,
        ),
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    const issues = contentEditIssues(input.edits);
    if (input.dryRun && issues.length > 0) {
      return { dryRun: true, ok: false, issues, working: null };
    }
    assertNoMdxIssues(issues);
    // A dry run writes nothing, so it may check edits against any branch.
    const branch = input.dryRun
      ? requireNamedBranch(input.branch)
      : await requireOwnBranch(context, authorized, input.branch);
    const working = await context.services.docs.applyEdits(
      docsActorFor(context, authorized),
      authorized.projectId,
      input.edits,
      branch,
      {
        expectedRevision: input.expectedRevision,
        dryRun: input.dryRun,
        onPagesChanged: context.recordPageChanges,
      },
    );
    return { dryRun: input.dryRun, ok: true, issues: [], working };
  },
});
