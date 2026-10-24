import { toEditableSiteConfig } from "@doxahq/site-config";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { docsActorFor } from "../docs/docs-actor";
import {
  branchInput,
  branchView,
  projectIdInput,
  READ_ONLY_ANNOTATIONS,
} from "../shared";

// The contract schema resolves defaults with transforms, which JSON Schema
// cannot express. The resource carries the exact schema instead.
const siteConfigOutput = z
  .record(z.string(), z.unknown())
  .describe(
    "Site settings. The JSON schema is the doxa://schemas/site-config resource.",
  );

export const getSiteSettingsTool = defineMcpTool({
  name: "get_site_settings",
  title: "Get site settings",
  description:
    'Returns the site settings (doxa.json) of a project. On "main" it returns the live, published settings, and working is null. On a branch, working holds the branch\'s settings when the branch changed them. The JSON schema is the doxa://schemas/site-config resource.',
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ projectId: projectIdInput, branch: branchInput }).strict(),
  output: z
    .object({
      siteConfig: z
        .object({
          published: siteConfigOutput,
          working: siteConfigOutput.nullable(),
        })
        .strict(),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.read");
    const view = branchView(input.branch);
    const overview = await context.services.docs.getOverview(
      docsActorFor(context, authorized),
      authorized.projectId,
      view.branch,
      view.options,
    );
    const { published, working } = overview.siteConfig;
    // The editable form keeps only the theme values a person chose, so an
    // agent can change the preset or primary color and see the effect.
    return {
      siteConfig: {
        published: toEditableSiteConfig(published),
        working: working ? toEditableSiteConfig(working) : null,
      },
      revision: overview.working.revision,
    };
  },
});
