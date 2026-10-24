import { z } from "zod";
import { DocsContentError } from "../../docs-content/errors";
import { ALL_APPROVAL_MODES, attributionOf, DEFAULT_TTL_HOURS } from "../action-definition";
import { restoreFreshness } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { liveSiteLabel } from "./shared";

const payloadSchema = z.object({ publicationId: z.uuid() }).strict();

const snapshotSchema = z
  .object({ expectedMainVersionId: z.uuid(), liveUrl: z.string().nullable() })
  .strict();

const resultSchema = z.object({ publicationId: z.uuid(), versionId: z.uuid() }).strict();

export const docsRestoreAction = defineProjectAction({
  kind: "docs.restore",
  payloadVersion: 1,
  title: "Restore a publication",
  scope: "publish",
  capability: "docs.restore",
  payloadSchema,
  snapshotSchema,
  resultSchema,
  approval: { defaultMode: "require_approval", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "approval_page" },
  // One restore at a time: two restores of one site race for the same pointer.
  targetKey: () => "site",
  reviewInputs: (payload) => ({ publicationId: payload.publicationId }),
  describe: (_payload, snapshot) => ({
    headline: "Restore an earlier publication",
    effects: [`${liveSiteLabel(snapshot.liveUrl)} goes back to the selected publication.`],
  }),
  async capture({ target, services }) {
    const scoped = { userId: target.ownerUserId, projectId: target.projectId };
    const mainVersionId = await services.restore.mainVersionId(scoped);
    if (mainVersionId === null) throw new DocsContentError("not_found", "Docs site not found.");
    return { expectedMainVersionId: mainVersionId, liveUrl: await services.liveSite.liveUrl(scoped) };
  },
  async checkFresh({ target, services }, _payload, snapshot) {
    const current = await services.restore.mainVersionId({
      userId: target.ownerUserId,
      projectId: target.projectId,
    });
    return restoreFreshness(snapshot.expectedMainVersionId, current);
  },
  execute(execution, payload, snapshot) {
    return execution.services.restore.restore({
      userId: execution.target.ownerUserId,
      projectId: execution.target.projectId,
      publicationId: payload.publicationId,
      expectedMainVersionId: snapshot.expectedMainVersionId,
      attribution: attributionOf(execution),
    });
  },
});
