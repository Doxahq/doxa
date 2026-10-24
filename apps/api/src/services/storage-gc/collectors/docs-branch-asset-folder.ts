import {
  DOCS_BRANCH_ASSET_FOLDER_TARGET,
  docsBranchAssetFolderResourceSchema,
  type DocsBranchAssetFolderResource,
  type StorageCollector,
} from "@doxahq/contracts/storage-gc";

import type { DocsVersionGcStore } from "../../../repositories/docs-version-gc";
import { parseBranchAssetPointer } from "../../docs-branches/assets/asset-pointer";
import {
  collectVersionPrefix,
  type OnVersionPrefixCollected,
  type VersionObjects,
} from "./docs-version-prefix";

/**
 * A branch keeps an image until a publish, a delete, or an erase removes its
 * change row, so a referenced folder is checked again later.
 */
export const REFERENCED_ASSET_FOLDER_RECHECK_SECONDS = 6 * 60 * 60;

/**
 * Deletes the upload folder of a branch image once no change row of any
 * branch of the site points to it: a branch created from the uploading
 * branch copies its image rows and still needs the folder. The blob stays for the blob sweep: a published or
 * preview version that copied the image still marks it.
 */
export function createDocsBranchAssetFolderCollector(input: {
  versions: Pick<
    DocsVersionGcStore,
    "isVersionPrefixInUse" | "listSiteAssetPointers"
  >;
  content: VersionObjects;
  onCollected?: OnVersionPrefixCollected;
}): StorageCollector<DocsBranchAssetFolderResource> {
  return {
    target: DOCS_BRANCH_ASSET_FOLDER_TARGET,
    parse: (resource) => docsBranchAssetFolderResourceSchema.parse(resource),
    async inspect(resource) {
      // A version row never uses an upload folder. If one does, it owns it.
      if (await input.versions.isVersionPrefixInUse(resource)) {
        return { status: "retain", reason: "version_row_exists" };
      }
      const pointers = await input.versions.listSiteAssetPointers({ siteId: resource.siteId });
      const referenced = pointers.some(
        (content) =>
          parseBranchAssetPointer(content)?.folderVersionId ===
          resource.versionId,
      );
      return referenced
        ? {
            status: "retain",
            reason: "asset_is_on_branch",
            recheckAfterSeconds: REFERENCED_ASSET_FOLDER_RECHECK_SECONDS,
          }
        : { status: "collect" };
    },
    collect: (resource) =>
      collectVersionPrefix(input.content, resource, input.onCollected),
  };
}
