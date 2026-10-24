import { docsAssetNameFromArtifactPath } from "@doxahq/contracts/docs-assets";
import type { StoredBranchChange } from "../../../repositories/docs-branches";
import { DocsContentError } from "../../docs-content/errors";
import {
  parseBranchAssetPointer,
  type BranchAssetPointer,
} from "./asset-pointer";

/** One image that a branch adds or replaces. */
export interface BranchAsset {
  /** The artifact path, `assets/{name}`. */
  path: string;
  name: string;
  pointer: BranchAssetPointer;
}

export function isAssetPath(path: string): boolean {
  return docsAssetNameFromArtifactPath(path) !== null;
}

/**
 * The asset changes of a branch. A row at an asset path with no valid pointer
 * is a defect, never user input, so it fails the operation.
 */
export function branchAssets(
  changes: readonly StoredBranchChange[],
): BranchAsset[] {
  return changes.flatMap((change) => {
    const name = docsAssetNameFromArtifactPath(change.path);
    if (!name || change.kind !== "upsert") return [];
    const pointer = parseBranchAssetPointer(change.content);
    if (!pointer) {
      throw new DocsContentError(
        "invalid",
        `The branch image at ${change.path} could not be read.`,
      );
    }
    return [{ path: change.path, name, pointer }];
  });
}
