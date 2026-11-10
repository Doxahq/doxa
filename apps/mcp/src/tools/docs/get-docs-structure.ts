import {
  docsContentNavigationSectionSchema,
  docsContentPageSchema,
  docsContentVersionSchema,
  docsContentWorkingSchema,
} from "@doxahq/contracts";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import {
  branchInput,
  branchView,
  projectIdInput,
  READ_ONLY_ANNOTATIONS,
} from "../shared";
import { docsActorFor } from "./docs-actor";
import { liveBranchId } from "../../live-activity";

export const getDocsStructureTool = defineMcpTool({
  name: "get_docs_structure",
  title: "Get docs structure",
  description:
    'Returns the pages and navigation of a project\'s docs: each page\'s href, title, and status, plus the branch revision. "main" shows the live, published site (revision 0); a branch shows its unpublished changes. Page content is not included; call read_page for one page.',
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ projectId: projectIdInput, branch: branchInput }).strict(),
  output: z
    .object({
      projectId: z.string(),
      projectSlug: z.string(),
      publishedVersion: docsContentVersionSchema,
      working: docsContentWorkingSchema,
      pages: z.array(
        docsContentPageSchema.pick({ href: true, title: true, status: true }),
      ),
      navigation: z.array(docsContentNavigationSectionSchema),
    })
    .strict(),
  describeActivity: (input) => [
    { kind: "read", branchId: liveBranchId(input.branch), detail: "Page list" },
  ],
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.read");
    const view = branchView(input.branch);
    const overview = await context.services.docs.getOverview(
      docsActorFor(context, authorized),
      authorized.projectId,
      view.branch,
      view.options,
    );
    return {
      projectId: overview.projectId,
      projectSlug: overview.projectSlug,
      publishedVersion: overview.publishedVersion,
      working: overview.working,
      pages: overview.pages.map(({ href, title, status }) => ({
        href,
        title,
        status,
      })),
      navigation: overview.navigation,
    };
  },
});
