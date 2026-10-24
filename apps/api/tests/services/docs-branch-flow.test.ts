import { describe, expect, test, vi } from "vitest";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { siteIdSchema, versionIdSchema } from "@doxahq/contracts/docs-branches";
import { InMemoryDocsBranchStore } from "../support/in-memory-docs-branches";
import { DocsBranchSync } from "../../src/services/docs-branches/sync";
import { DocsBranchPublish } from "../../src/services/docs-branches/publish";
import { freePlanEntitlements } from "../../src/services/free-plan-entitlements";
import type { PublishStoredBranchInput } from "../../src/repositories/docs-branch-publication";
import { createInMemoryDocsContentStore } from "../support/in-memory-docs-content-store";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const siteId = "33333333-3333-4333-8333-333333333333";
const baseId = "44444444-4444-4444-8444-444444444444";
const mainId = "55555555-5555-4555-8555-555555555555";
const basePrefix = buildArtifactPrefix(siteId, baseId);
const mainPrefix = buildArtifactPrefix(siteId, mainId);

function manifest(
  versionId: string,
  pages = [{ href: "/", title: "Home", sourcePath: "source/index.mdx" }],
) {
  return JSON.stringify({
    siteId,
    versionId,
    projectSlug: "example",
    generatedAt: "2026-09-24T00:00:00.000Z",
    pages,
  });
}

function fixture() {
  const objects = new Map<string, string>([
    [`${basePrefix}/manifest.json`, manifest(baseId)],
    [`${basePrefix}/source/index.mdx`, "---\ntitle: Home\n---\n\n# Base\n"],
    [
      `${basePrefix}/settings/sections.json`,
      JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
    ],
    [
      `${basePrefix}/settings/documents.json`,
      JSON.stringify([{ href: "/", title: "Home" }]),
    ],
  ]);
  const store = createInMemoryDocsContentStore(objects);
  const branches = new InMemoryDocsBranchStore();
  branches.addSite(userId, {
    id: siteIdSchema.parse(siteId),
    projectId,
    projectName: "Example",
    projectSlug: "example",
    mainVersionId: versionIdSchema.parse(baseId),
    mainVersionNumber: 1,
    mainArtifactPrefix: basePrefix,
    mainCreatedAt: new Date(),
  });
  const sync = new DocsBranchSync(branches, store);
  return { store, objects, branches, sync };
}

async function editHome(
  branches: InMemoryDocsBranchStore,
  content: string,
  origin: "editor" | "agent" = "editor",
) {
  const branch = await branches.getOrCreateHiddenBranch({ userId, projectId });
  if (!branch) throw new Error("Hidden branch not created");
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const contentSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await branches.writeChanges({
    userId,
    projectId,
    branchId: branch.id,
    expectedRevision: branch.revision,
    origin,
    changes: [
      {
        path: "source/index.mdx",
        kind: "upsert",
        content,
        contentSha256,
        byteSize: bytes.length,
      },
    ],
  });
}

describe("branch synchronization and publish", () => {
  test("a generation moves main, synchronization keeps both changes, then publish writes both", async () => {
    const { store, objects, branches, sync } = fixture();
    await editHome(
      branches,
      "---\ntitle: Home\n---\n\n# Branch edit\n",
      "agent",
    );
    const pages = [
      { href: "/", title: "Home", sourcePath: "source/index.mdx" },
      { href: "/guide", title: "Guide", sourcePath: "source/guide/index.mdx" },
    ];
    objects.set(`${mainPrefix}/manifest.json`, manifest(mainId, pages));
    objects.set(
      `${mainPrefix}/source/index.mdx`,
      objects.get(`${basePrefix}/source/index.mdx`) ?? "",
    );
    objects.set(
      `${mainPrefix}/source/guide/index.mdx`,
      "---\ntitle: Guide\n---\n\n# Guide\n",
    );
    objects.set(
      `${mainPrefix}/settings/sections.json`,
      objects.get(`${basePrefix}/settings/sections.json`) ?? "",
    );
    objects.set(
      `${mainPrefix}/settings/documents.json`,
      JSON.stringify([
        { href: "/", title: "Home" },
        { href: "/guide", title: "Guide" },
      ]),
    );
    branches.setMainVersion(siteId, mainId, mainPrefix, 2);
    const preview = await sync.preview({ userId, projectId, branch: "main" });
    expect(preview).toMatchObject({
      behind: true,
      conflicts: [],
      autoResolvedCount: 1,
    });
    const publish = vi.fn(async (_input: PublishStoredBranchInput) => ({
      result: {
        versionId: "66666666-6666-4666-8666-666666666666",
        versionNumber: 3,
        publicationId: "77777777-7777-4777-8777-777777777777",
        branchErased: true,
      },
      collectEntryIds: ["gc-preview-1"],
      review: null,
    }));
    const collectStorage = vi.fn(async (_entryIds: readonly string[]) => {});
    const publisher = new DocsBranchPublish({
      branches,
      store,
      entitlements: freePlanEntitlements,
      assets: { head: async () => null },
      publish,
      collectStorage,
      enqueueOrphanVersion: vi.fn(async () => undefined),
    });
    const rejectedStages: string[] = [];
    await expect(
      publisher.publish({
        userId,
        projectId,
        branch: "main",
        request: {
          expectedBaseVersionId: baseId,
          expectedRevision: 0,
          eraseBranch: true,
        },
        onStage: (stage) => rejectedStages.push(stage),
      }),
    ).rejects.toMatchObject({ code: "branch_behind" });
    expect(rejectedStages).toEqual(["preparing"]);
    await sync.synchronize({
      userId,
      projectId,
      branch: "main",
      request: { expectedMainVersionId: mainId, resolutions: [] },
    });
    expect(
      (await branches.listChanges({ userId, projectId, branch: "main" }))[0]
        ?.origin,
    ).toBe("agent");
    const reviewed = await branches.getBranchForUser({
      userId,
      projectId,
      branch: "main",
    });
    const reviewedRevision = reviewed?.revision ?? -1;
    await expect(
      publisher.publish({
        userId,
        projectId,
        branch: "main",
        request: {
          expectedBaseVersionId: mainId,
          expectedRevision: reviewedRevision - 1,
          eraseBranch: true,
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(publish).not.toHaveBeenCalled();
    const stages: string[] = [];
    const result = await publisher.publish({
      userId,
      projectId,
      branch: "main",
      request: {
        expectedBaseVersionId: mainId,
        expectedRevision: reviewedRevision,
        eraseBranch: true,
      },
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(["preparing", "building", "optimizing"]);
    expect(result.versionNumber).toBe(3);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].expectedRevision).toBe(reviewedRevision);
    expect(collectStorage).toHaveBeenCalledWith(["gc-preview-1"]);
    const input = publish.mock.calls[0]?.[0];
    expect(input?.summary).toMatchObject({ changedPageCount: 1 });
    expect(objects.get(`${input?.artifactPrefix}/source/index.mdx`)).toContain(
      "Branch edit",
    );
    expect(
      objects.get(`${input?.artifactPrefix}/source/guide/index.mdx`),
    ).toContain("# Guide");
  });

  test("a conflicting page requires resolution and main resolution clears its row", async () => {
    const { objects, branches, sync } = fixture();
    await editHome(branches, "# Mine");
    for (const [key, value] of [...objects])
      objects.set(key.replace(basePrefix, mainPrefix), value);
    objects.set(`${mainPrefix}/source/index.mdx`, "# Main");
    branches.setMainVersion(siteId, mainId, mainPrefix, 2);
    const preview = await sync.preview({ userId, projectId, branch: "main" });
    expect(preview.conflicts).toEqual([
      expect.objectContaining({ key: "page:/" }),
    ]);
    await expect(
      sync.synchronize({
        userId,
        projectId,
        branch: "main",
        request: { expectedMainVersionId: mainId, resolutions: [] },
      }),
    ).rejects.toMatchObject({ code: "conflicts_unresolved" });
    await sync.synchronize({
      userId,
      projectId,
      branch: "main",
      request: {
        expectedMainVersionId: mainId,
        resolutions: [{ key: "page:/", resolution: "main" }],
      },
    });
    expect(
      await branches.listChanges({ userId, projectId, branch: "main" }),
    ).toEqual([]);
  });

  test("keeping the branch structure keeps a page that main deleted", async () => {
    const { objects, branches, sync } = fixture();
    const guide = "---\ntitle: Guide\n---\n\n# Guide\n";
    const basePages = [
      { href: "/", title: "Home", sourcePath: "source/index.mdx" },
      { href: "/guide", title: "Guide", sourcePath: "source/guide/index.mdx" },
    ];
    objects.set(`${basePrefix}/manifest.json`, manifest(baseId, basePages));
    objects.set(`${basePrefix}/source/guide/index.mdx`, guide);
    objects.set(
      `${basePrefix}/settings/documents.json`,
      JSON.stringify([
        { href: "/", title: "Home" },
        { href: "/guide", title: "Guide" },
      ]),
    );
    // The branch reorders the navigation, which is a structure edit.
    await writeRow(
      branches,
      "settings/documents.json",
      JSON.stringify([
        { href: "/guide", title: "Guide" },
        { href: "/", title: "Home" },
      ]),
    );
    // Main deletes /guide.
    objects.set(`${mainPrefix}/manifest.json`, manifest(mainId));
    for (const path of [
      "source/index.mdx",
      "settings/sections.json",
    ]) {
      objects.set(`${mainPrefix}/${path}`, objects.get(`${basePrefix}/${path}`) ?? "");
    }
    objects.set(
      `${mainPrefix}/settings/documents.json`,
      JSON.stringify([{ href: "/", title: "Home" }]),
    );
    branches.setMainVersion(siteId, mainId, mainPrefix, 2);

    await sync.synchronize({
      userId,
      projectId,
      branch: "main",
      request: {
        expectedMainVersionId: mainId,
        resolutions: [{ key: "structure", resolution: "mine" }],
      },
    });

    const rows = await branches.listChanges({ userId, projectId, branch: "main" });
    expect(rows).toContainEqual(
      expect.objectContaining({
        path: "source/guide/index.mdx",
        kind: "upsert",
        content: guide,
      }),
    );
  });
});

async function writeRow(
  branches: InMemoryDocsBranchStore,
  path: string,
  content: string,
) {
  const branch = await branches.getOrCreateHiddenBranch({ userId, projectId });
  if (!branch) throw new Error("Hidden branch not created");
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const contentSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await branches.writeChanges({
    userId,
    projectId,
    branchId: branch.id,
    expectedRevision: branch.revision,
    origin: "editor",
    changes: [
      { path, kind: "upsert", content, contentSha256, byteSize: bytes.length },
    ],
  });
}
