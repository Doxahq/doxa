import { docsAssetContentTypeSchema } from "@doxahq/contracts/docs-assets";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { z } from "zod";

/**
 * The content of a branch change at `assets/{name}`.
 *
 * A branch change row holds text, and images can be megabytes. So the upload
 * writes the image as a one-file version folder through the version tree
 * writer, and the row holds this pointer to it. A publish or a preview copies
 * the tree entry of the folder into the new version: no blob is read or
 * written again. The folder's tree keeps the blob safe from the blob sweep;
 * the `docs_branch_asset_folder` collector removes the folder when no change
 * row points to it any more.
 */
export const branchAssetPointerSchema = z
  .object({
    format: z.literal("doxa-branch-asset"),
    formatVersion: z.literal(1),
    folderVersionId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    contentType: docsAssetContentTypeSchema,
  })
  .strict();

export type BranchAssetPointer = z.infer<typeof branchAssetPointerSchema>;

export function encodeBranchAssetPointer(
  pointer: Omit<BranchAssetPointer, "format" | "formatVersion">,
): string {
  return JSON.stringify(
    branchAssetPointerSchema.parse({
      format: "doxa-branch-asset",
      formatVersion: 1,
      ...pointer,
    }),
  );
}

/** Null when the content is not a valid pointer. */
export function parseBranchAssetPointer(
  content: string,
): BranchAssetPointer | null {
  try {
    const parsed = branchAssetPointerSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The upload folder of a pointer; it belongs to the branch's site. */
export function branchAssetFolderPrefix(
  siteId: string,
  pointer: BranchAssetPointer,
): string {
  return buildArtifactPrefix(siteId, pointer.folderVersionId);
}
