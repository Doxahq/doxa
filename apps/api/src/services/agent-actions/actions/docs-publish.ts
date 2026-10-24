import { z } from "zod";
import { publishDocsBranchResultSchema } from "@doxahq/contracts/docs-branches";
import { DocsContentError } from "../../docs-content/errors";
import { describeBlockedPublish } from "../../docs-content/page-mdx-issues";
import { ALL_APPROVAL_MODES, attributionOf, DEFAULT_TTL_HOURS } from "../action-definition";
import { publishFreshness } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { DOCS_PUBLISH_ACTION_KIND, publishTargetKey } from "./publish-target";
import { liveSiteLabel, plural } from "./shared";

const payloadSchema = z
  .object({ branchId: z.uuid(), eraseBranch: z.boolean().default(false) })
  .strict();

const snapshotSchema = z
  .object({
    branchId: z.uuid(),
    branchName: z.string(),
    baseVersionId: z.uuid(),
    revision: z.number().int().nonnegative(),
    changeCount: z.number().int().nonnegative(),
    liveUrl: z.string().nullable(),
  })
  .strict();

const resultSchema = publishDocsBranchResultSchema.extend({ liveUrl: z.string().nullable() }).strict();

export const docsPublishAction = defineProjectAction({
  kind: DOCS_PUBLISH_ACTION_KIND,
  payloadVersion: 1,
  title: "Publish a branch",
  scope: "publish",
  capability: "docs.publish",
  payloadSchema,
  snapshotSchema,
  resultSchema,
  approval: { defaultMode: "require_approval", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "publish_menu" },
  targetKey: (payload) => publishTargetKey(payload.branchId),
  branchId: (payload) => payload.branchId,
  applyChoices: (payload, choices) => ({ ...payload, eraseBranch: choices.eraseBranch ?? payload.eraseBranch }),
  reviewInputs: (payload) => ({ branchId: payload.branchId, eraseBranch: payload.eraseBranch }),
  // The decider picks whether the branch is erased, so the effects leave it out.
  describe: (_payload, snapshot) => ({
    headline: `Publish ${plural(snapshot.changeCount, "change")} from ${snapshot.branchName}`,
    effects: [`${liveSiteLabel(snapshot.liveUrl)} changes.`],
  }),
  async capture({ target, services }, payload) {
    const scoped = { userId: target.ownerUserId, projectId: target.projectId };
    const branch = await services.publish.readBranch({ ...scoped, branchId: payload.branchId });
    if (branch === null) throw new DocsContentError("branch_not_found", "Branch not found.");
    if (branch.changeCount === 0) {
      throw new DocsContentError("no_changes", "This branch has no changes to publish.");
    }
    // No request starts for a branch that cannot go live. The snapshot pins
    // the revision, and `execute` checks the pages again before it publishes.
    const mdxPages = await services.publish.mdxIssues({ ...scoped, branchId: payload.branchId });
    if (mdxPages.length > 0) {
      throw new DocsContentError("mdx_invalid", describeBlockedPublish(mdxPages));
    }
    return {
      branchId: branch.branchId,
      branchName: branch.branchName,
      baseVersionId: branch.baseVersionId,
      revision: branch.revision,
      changeCount: branch.changeCount,
      liveUrl: await services.liveSite.liveUrl(scoped),
    };
  },
  async checkFresh({ target, services }, payload, snapshot) {
    const current = await services.publish.readBranch({
      userId: target.ownerUserId,
      projectId: target.projectId,
      branchId: payload.branchId,
    });
    return publishFreshness(snapshot, current);
  },
  async execute(execution, payload, snapshot) {
    const { target, services } = execution;
    const published = await services.publish.publish({
      userId: target.ownerUserId,
      projectId: target.projectId,
      branchId: payload.branchId,
      request: {
        expectedBaseVersionId: snapshot.baseVersionId,
        expectedRevision: snapshot.revision,
        eraseBranch: payload.eraseBranch,
      },
      attribution: attributionOf(execution),
      onStage: execution.onProgress,
    });
    return { ...published, liveUrl: snapshot.liveUrl };
  },
});
