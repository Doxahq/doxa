import {
  DOCS_CONTENT_MAX_PAGE_BYTES,
  docsContentWorkingSchema,
} from "@doxahq/contracts";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import {
  expectedRevisionInput,
  namedBranchInput,
  projectIdInput,
  writeAnnotations,
} from "../shared";
import { assertNoMdxIssues, pageSourceIssues } from "./content-edits";
import { docsActorFor } from "./docs-actor";
import { OWN_BRANCH_ONLY, requireOwnBranch } from "../branches/branch-ownership";

export const writePageTool = defineMcpTool({
  name: "write_page",
  title: "Write page",
  description:
    `Replaces the whole MDX source of an existing page on a named branch, frontmatter included. The source must parse as MDX with the supported components (see the doxa://reference/mdx resource); otherwise the call fails with mdx_invalid and writes nothing. To add, move, or rename pages, use edit_docs. ${OWN_BRANCH_ONLY}`,
  scope: "docs:write",
  cost: "write",
  annotations: writeAnnotations(true),
  input: z
    .object({
      projectId: projectIdInput,
      branch: namedBranchInput,
      href: z
        .string()
        .min(1)
        .max(500)
        .describe("The page href, from get_docs_structure."),
      content: z.string().max(DOCS_CONTENT_MAX_PAGE_BYTES),
      expectedRevision: expectedRevisionInput,
    })
    .strict(),
  output: z.object({ working: docsContentWorkingSchema }).strict(),
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    assertNoMdxIssues(pageSourceIssues(input.content, "/content"));
    const branch = await requireOwnBranch(context, authorized, input.branch);
    const working = await context.services.docs.applyEdits(
      docsActorFor(context, authorized),
      authorized.projectId,
      [{ type: "set_page_content", href: input.href, content: input.content }],
      branch,
      { expectedRevision: input.expectedRevision },
    );
    return { working };
  },
});

