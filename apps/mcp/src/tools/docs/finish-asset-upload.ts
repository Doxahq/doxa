import {
  agentAssetUploadIdSchema,
  docsAssetUploadResultSchema,
} from "@doxahq/contracts/docs-assets";
import { z } from "zod";
import { editOriginFor } from "@doxahq/api/services/agent-access/actor";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import { defineMcpTool } from "../../tool-definition";
import { agentIdentity } from "../branches/branch-view";
import { requireOwnBranch } from "../branches/branch-ownership";
import { projectIdInput, writeAnnotations } from "../shared";
import { ALT_TEXT_DESCRIPTION, imageMarkdown } from "./asset-markdown";

/** Errors that the same file gives again, so the staged file is useless. */
const FINAL_ERRORS = new Set(["asset_invalid", "asset_too_large"]);

function uploadNotFound(): DocsContentError {
  return new DocsContentError(
    "asset_upload_not_found",
    "Upload not found. It expired, it finished already, or another connection created it.",
  );
}

export const finishAssetUploadTool = defineMcpTool({
  name: "finish_asset_upload",
  title: "Finish image upload",
  description:
    "Adds the image that you sent to the upload URL of create_asset_upload to its branch, and returns the path to use in MDX, for example /assets/rate-limits-diagram.png. Call it after the PUT succeeded. The image is checked like upload_asset checks it: the type comes from the bytes, SVG files are cleaned (sanitized: true), and a name in use gets a number suffix. PNG and JPEG images can be compressed and stored as WebP, so the returned path and contentType can differ from what you sent. Always use the returned path. Put the path in a page with write_page or edit_docs. The image goes live with the next approved publish of the branch, and build_preview shows it.",
  scope: "docs:write",
  cost: "expensive",
  annotations: writeAnnotations(true),
  input: z
    .object({
      projectId: projectIdInput,
      uploadId: agentAssetUploadIdSchema.describe(
        "The uploadId from create_asset_upload.",
      ),
      altText: z.string().max(300).optional().describe(ALT_TEXT_DESCRIPTION),
    })
    .strict(),
  output: docsAssetUploadResultSchema,
  describeActivity: (_input, output) => [{ kind: "edit", detail: output.path }],
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    // Only the connection that created the URL can finish it, on its project:
    // any other caller gets not_found before a byte of the file is read.
    const staged = await context.services.assetUploads.takeFor(input.uploadId, {
      projectId: authorized.projectId,
      agent: agentIdentity(context.actor),
    });
    if (staged.kind === "not_found") throw uploadNotFound();
    if (staged.kind === "not_sent") {
      throw new DocsContentError(
        "asset_upload_not_sent",
        "The upload URL has not received a file yet.",
      );
    }
    const branch = await requireOwnBranch(
      context,
      authorized,
      staged.ticket.branchId,
    );
    try {
      const uploaded = await context.services.branches.uploadAsset({
        userId: authorized.ownerUserId,
        projectId: authorized.projectId,
        branch,
        origin: editOriginFor(context.actor),
        fileName: staged.ticket.fileName,
        bytes: staged.bytes,
      });
      await context.services.assetUploads.discard(staged.ticket);
      return {
        ...uploaded,
        markdown: imageMarkdown(uploaded.path, input.altText),
      };
    } catch (error) {
      if (error instanceof DocsContentError && FINAL_ERRORS.has(error.code)) {
        await context.services.assetUploads.discard(staged.ticket);
      }
      throw error;
    }
  },
});
