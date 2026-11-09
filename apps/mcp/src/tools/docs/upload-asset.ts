import {
  AGENT_ASSET_UPLOAD_LIMITS,
  DOCS_ASSET_LIMITS,
  docsAssetUploadResultSchema,
} from "@doxahq/contracts/docs-assets";
import { z } from "zod";
import { decodeAssetBase64 } from "@doxahq/api/services/docs-branches/assets/asset-content";
import { editOriginFor } from "@doxahq/api/services/agent-access/actor";
import { defineMcpTool } from "../../tool-definition";
import {
  namedBranchInput,
  projectIdInput,
  writeAnnotations,
} from "../shared";
import { OWN_BRANCH_ONLY, requireOwnBranch } from "../branches/branch-ownership";
import { ALT_TEXT_DESCRIPTION, imageMarkdown } from "./asset-markdown";

const MAX_MB = DOCS_ASSET_LIMITS.maxBytes / (1024 * 1024);
const INLINE_KB = AGENT_ASSET_UPLOAD_LIMITS.inlineBytesHint / 1024;
/** Base64 of the largest file, with room for line breaks. */
const MAX_BASE64_LENGTH =
  Math.ceil(DOCS_ASSET_LIMITS.maxBytes / 3) * 4 + 65_536;

export const uploadAssetTool = defineMcpTool({
  name: "upload_asset",
  title: "Upload image",
  description: `Adds a small image to a named branch from base64 in this call, and returns the path to use in MDX, for example /assets/rate-limits-diagram.png. For any file larger than about ${INLINE_KB} KB, or whenever you can run a shell command, use create_asset_upload and finish_asset_upload instead: you must write every base64 character of this call yourself, so a large file fails or gets cut. Send PNG, JPEG, WebP, GIF, or SVG bytes as standard base64, at most ${MAX_MB} MB. The type comes from the bytes, not the file name. PNG and JPEG images can be compressed and stored as WebP, so the returned path and contentType can differ from what you sent. Always use the returned path. SVG files are cleaned: scripts, event attributes, and external references are removed (sanitized: true). A branch can add ${DOCS_ASSET_LIMITS.maxFilesPerBranch} images. A name in use gets a number suffix, so always use the returned path; the same file again returns its path (reused: true). Put the path in a page with write_page or edit_docs. The image goes live with the next approved publish of the branch, and build_preview shows it. ${OWN_BRANCH_ONLY}`,
  scope: "docs:write",
  cost: "expensive",
  annotations: writeAnnotations(true),
  input: z
    .object({
      projectId: projectIdInput,
      branch: namedBranchInput,
      fileName: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "A file name such as rate-limits-diagram.png. It becomes a lowercase slug.",
        ),
      contentBase64: z
        .string()
        .min(1)
        .max(MAX_BASE64_LENGTH)
        .describe("The file bytes in standard base64, without a data: prefix."),
      altText: z
        .string()
        .max(300)
        .optional()
        .describe(ALT_TEXT_DESCRIPTION),
    })
    .strict(),
  output: docsAssetUploadResultSchema,
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    const bytes = decodeAssetBase64(input.contentBase64);
    const branch = await requireOwnBranch(context, authorized, input.branch);
    const uploaded = await context.services.branches.uploadAsset({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      branch,
      origin: editOriginFor(context.actor),
      fileName: input.fileName,
      bytes,
    });
    return {
      ...uploaded,
      markdown: imageMarkdown(uploaded.path, input.altText),
    };
  },
});
