import {
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
  requireNamedBranch,
  writeAnnotations,
} from "../shared";

const MAX_MB = DOCS_ASSET_LIMITS.maxBytes / (1024 * 1024);
/** Base64 of the largest file, with room for line breaks. */
const MAX_BASE64_LENGTH =
  Math.ceil(DOCS_ASSET_LIMITS.maxBytes / 3) * 4 + 65_536;

/** Alt text inside `![...]`: one line, no brackets. */
function imageMarkdown(path: string, altText: string | undefined): string {
  const alt = (altText ?? "")
    .replace(/[[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `![${alt}](${path})`;
}

export const uploadAssetTool = defineMcpTool({
  name: "upload_asset",
  title: "Upload image",
  description: `Adds an image to a named branch and returns the path to use in MDX, for example /assets/rate-limits-diagram.png. Send PNG, JPEG, WebP, GIF, or SVG bytes as base64, at most ${MAX_MB} MB. The type comes from the bytes, not the file name. SVG files are cleaned: scripts, event attributes, and external references are removed (sanitized: true). A branch can add ${DOCS_ASSET_LIMITS.maxFilesPerBranch} images. A name in use gets a number suffix, so always use the returned path; the same file again returns its path (reused: true). Put the path in a page with write_page or edit_docs. The image goes live with the next approved publish of the branch, and build_preview shows it.`,
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
        .describe("Alt text for the returned markdown line."),
    })
    .strict(),
  output: docsAssetUploadResultSchema,
  async run(context, input) {
    const branch = requireNamedBranch(input.branch);
    const authorized = await context.authorize(input.projectId, "docs.write");
    const bytes = decodeAssetBase64(input.contentBase64);
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
