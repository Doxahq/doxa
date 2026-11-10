import { docsContentWorkingSchema } from "@doxahq/contracts";
import { toEditableSiteConfig } from "@doxahq/site-config";
import { z } from "zod";
import type { DocsContentActor } from "@doxahq/api/services/docs-content/service";
import { validateSiteConfig } from "@doxahq/api/services/site-config-validation";
import { defineMcpTool, type ToolContext } from "../../tool-definition";
import { docsActorFor } from "../docs/docs-actor";
import {
  expectedRevisionInput,
  namedBranchInput,
  projectIdInput,
  writeAnnotations,
} from "../shared";
import { applyMergePatch } from "./merge-patch";
import { OWN_BRANCH_ONLY, requireOwnBranch } from "../branches/branch-ownership";
import { liveBranchId } from "../../live-activity";

// The contract schema resolves defaults with transforms, which JSON Schema
// cannot express. The doxa://schemas/site-config resource has the schema.
const siteConfigObject = z.record(z.string(), z.unknown());

const updateInput = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("replace"),
      config: siteConfigObject.describe("The complete site settings."),
    })
    .strict(),
  z
    .object({
      mode: z.literal("merge_patch"),
      patch: siteConfigObject.describe(
        "An RFC 7396 merge patch: objects merge, null removes a field, other values replace.",
      ),
    })
    .strict(),
]);

type SiteSettingsUpdate = z.infer<typeof updateInput>;

interface UpdateTarget {
  actor: DocsContentActor;
  projectId: string;
  branch: string;
}

interface NextConfig {
  config: ReturnType<typeof validateSiteConfig>;
  expectedRevision: number | undefined;
}

export const updateSiteSettingsTool = defineMcpTool({
  name: "update_site_settings",
  title: "Update site settings",
  description:
    `Changes the site settings (doxa.json) on a named branch. Use mode "merge_patch" with a small patch, for example {"theme":{"primary":"#2563eb"}}, or mode "replace" with the complete settings. The result is validated against the schema (doxa://schemas/site-config), the plan, and the uploaded assets; a failure returns validation_failed with issues and writes nothing. ${OWN_BRANCH_ONLY}`,
  scope: "site:write",
  cost: "write",
  annotations: writeAnnotations(true),
  input: z
    .object({
      projectId: projectIdInput,
      branch: namedBranchInput,
      update: updateInput,
      expectedRevision: expectedRevisionInput,
    })
    .strict(),
  output: z
    .object({
      siteConfig: siteConfigObject,
      working: docsContentWorkingSchema,
    })
    .strict(),
  describeActivity: (input) => [
    { kind: "edit", branchId: liveBranchId(input.branch), detail: "Site settings" },
  ],
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "site.write");
    const target: UpdateTarget = {
      actor: docsActorFor(context, authorized),
      projectId: authorized.projectId,
      branch: await requireOwnBranch(context, authorized, input.branch),
    };
    const next = await nextConfig(context, target, input);
    const working = await context.services.docs.applyEdits(
      target.actor,
      target.projectId,
      [{ type: "set_site_config", config: next.config }],
      target.branch,
      { expectedRevision: next.expectedRevision },
    );
    return { siteConfig: toEditableSiteConfig(next.config), working };
  },
});

async function nextConfig(
  context: ToolContext,
  target: UpdateTarget,
  input: { update: SiteSettingsUpdate; expectedRevision?: number },
): Promise<NextConfig> {
  const { update } = input;
  if (update.mode === "replace") {
    return {
      config: validateSiteConfig(update.config),
      expectedRevision: input.expectedRevision,
    };
  }
  const overview = await context.services.docs.getOverview(
    target.actor,
    target.projectId,
    target.branch,
  );
  // The patch applies to the editable form, as in the dashboard: the resolved
  // form pins every theme token, so a patch to `theme.primary` would not show.
  const current = toEditableSiteConfig(
    overview.siteConfig.working ?? overview.siteConfig.published,
  );
  return {
    config: validateSiteConfig(applyMergePatch(current, update.patch)),
    // The patch applies to the settings read here, so a concurrent write
    // must fail instead of being overwritten.
    expectedRevision: input.expectedRevision ?? overview.working.revision,
  };
}
