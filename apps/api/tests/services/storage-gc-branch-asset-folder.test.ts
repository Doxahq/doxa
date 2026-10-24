import { describe, expect, test, vi } from "vitest";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { encodeBranchAssetPointer } from "../../src/services/docs-branches/assets/asset-pointer";
import {
  createDocsBranchAssetFolderCollector,
  REFERENCED_ASSET_FOLDER_RECHECK_SECONDS,
} from "../../src/services/storage-gc/collectors/docs-branch-asset-folder";

const resource = {
  siteId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  branchId: "33333333-3333-4333-8333-333333333333",
};
const prefix = `${buildArtifactPrefix(resource.siteId, resource.versionId)}/`;

function pointerTo(folderVersionId: string): string {
  return encodeBranchAssetPointer({
    folderVersionId,
    sha256: "a".repeat(64),
    size: 10,
    contentType: "image/png",
  });
}

function collector(input: {
  pointers?: string[];
  inUse?: boolean;
  removeMany?: (keys: readonly string[]) => Promise<void>;
  onCollected?: () => Promise<unknown>;
}) {
  const listSiteAssetPointers = vi.fn(async () => input.pointers ?? []);
  return {
    listSiteAssetPointers,
    collector: createDocsBranchAssetFolderCollector({
      versions: {
        isVersionPrefixInUse: async () => input.inUse ?? false,
        listSiteAssetPointers,
      },
      content: {
        listKeys: async (keyPrefix) =>
          keyPrefix === prefix ? [`${prefix}tree.json`] : [],
        removeMany: input.removeMany ?? (async () => undefined),
      },
      onCollected: input.onCollected,
    }),
  };
}

describe("branch image folder collector", () => {
  test("keeps a folder that a change row of any branch of the site points to", async () => {
    const { collector: subject, listSiteAssetPointers } = collector({
      pointers: [
        pointerTo("44444444-4444-4444-8444-444444444444"),
        pointerTo(resource.versionId),
      ],
    });

    expect(await subject.inspect(subject.parse(resource))).toEqual({
      status: "retain",
      reason: "asset_is_on_branch",
      recheckAfterSeconds: REFERENCED_ASSET_FOLDER_RECHECK_SECONDS,
    });
    // Every branch of the site counts: a branch made from the uploading
    // branch copies its image rows (regression: the folder was collected
    // while the copy still pointed to it).
    expect(listSiteAssetPointers).toHaveBeenCalledWith({ siteId: resource.siteId });
  });

  test("collects a folder after a publish, a replace, or a branch delete", async () => {
    const replaced = collector({
      pointers: [
        pointerTo("44444444-4444-4444-8444-444444444444"),
        "not a pointer",
      ],
    });
    const deletedBranch = collector({ pointers: [] });

    expect(await replaced.collector.inspect(resource)).toEqual({
      status: "collect",
    });
    expect(await deletedBranch.collector.inspect(resource)).toEqual({
      status: "collect",
    });
  });

  test("never collects a folder that a version row owns", async () => {
    const { collector: subject } = collector({ inUse: true });
    expect(await subject.inspect(resource)).toEqual({
      status: "retain",
      reason: "version_row_exists",
    });
  });

  test("deletes only the folder tree and hands the blobs to the sweep", async () => {
    const removeMany = vi.fn(async () => undefined);
    const onCollected = vi.fn(async () => undefined);
    const { collector: subject } = collector({ removeMany, onCollected });

    await expect(subject.collect(resource)).resolves.toEqual({
      deletedObjects: 1,
      status: "complete",
    });
    expect(removeMany).toHaveBeenCalledWith([`${prefix}tree.json`]);
    expect(onCollected).toHaveBeenCalledWith(resource);
  });

  test("rejects a resource without its branch", () => {
    const { collector: subject } = collector({});
    expect(() =>
      subject.parse({ siteId: resource.siteId, versionId: resource.versionId }),
    ).toThrow();
  });
});
