import {
  DOCS_CONTENT_MAX_PAGE_BYTES,
  docsContentPageStatusSchema,
} from "@doxahq/contracts";
import { z } from "zod";
import { defineMcpTool, type ToolContext } from "../../tool-definition";
import {
  branchInput,
  branchView,
  projectIdInput,
  READ_ONLY_ANNOTATIONS,
} from "../shared";
import { docsActorFor } from "./docs-actor";
import { liveBranchId } from "../../live-activity";

export const readPageTool = defineMcpTool({
  name: "read_page",
  title: "Read page",
  description:
    'Returns the MDX source of one page with the branch revision. On "main" it returns the live, published page (revision 0). On a branch it includes the branch\'s unpublished edits.',
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z
    .object({
      projectId: projectIdInput,
      href: z
        .string()
        .min(1)
        .max(500)
        .describe("The page href, from get_docs_structure."),
      branch: branchInput,
    })
    .strict(),
  output: z
    .object({
      href: z.string(),
      title: z.string(),
      sourcePath: z.string(),
      status: docsContentPageStatusSchema,
      content: z.string().max(DOCS_CONTENT_MAX_PAGE_BYTES),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  describeActivity: (input, output) => [
    {
      kind: "read",
      branchId: liveBranchId(input.branch),
      pageHref: output.href,
      pageTitle: output.title,
    },
  ],
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.read");
    const { branch, options } = branchView(input.branch);
    const [page, revision] = await Promise.all([
      context.services.docs.getPage(
        docsActorFor(context, authorized),
        authorized.projectId,
        input.href,
        branch,
        options,
      ),
      branchRevision(context, {
        userId: authorized.ownerUserId,
        projectId: authorized.projectId,
        branch,
      }),
    ]);
    return {
      href: page.href,
      title: page.title,
      sourcePath: page.sourcePath,
      status: page.status,
      content: page.workingContent ?? page.publishedContent,
      revision,
    };
  },
});

/** The published site has no revision; only a named branch counts edits. */
async function branchRevision(
  context: ToolContext,
  input: { userId: string; projectId: string; branch: string },
): Promise<number> {
  if (input.branch === "main") return 0;
  const status = await context.services.branches.getStatus(input);
  return status.branch.revision;
}
