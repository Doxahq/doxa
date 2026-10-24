import { describe, expect, it } from "vitest";
import { siteIdSchema, versionIdSchema } from "@doxahq/contracts/docs-branches";
import { InMemoryDocsBranchStore } from "../support/in-memory-docs-branches";

const site = {
  id: siteIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  projectId: "00000000-0000-4000-8000-000000000002",
  projectName: "Example",
  projectSlug: "example",
  mainVersionId: versionIdSchema.parse("00000000-0000-4000-8000-000000000003"),
  mainVersionNumber: 1,
  mainCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
  mainArtifactPrefix:
    "sites/00000000-0000-4000-8000-000000000001/versions/00000000-0000-4000-8000-000000000003",
};

describe("the branch store test double", () => {
  it("returns one hidden branch for parallel first edits", async () => {
    const store = new InMemoryDocsBranchStore();
    store.addSite("owner", site);
    const input = { userId: "owner", projectId: site.projectId };
    const [first, second] = await Promise.all([
      store.getOrCreateHiddenBranch(input),
      store.getOrCreateHiddenBranch(input),
    ]);
    expect(first?.id).toBe(second?.id);
    expect(first?.baseVersionId).toBe(site.mainVersionId);
    expect(
      (await store.getBranchForUser({ ...input, branch: "main" }))?.id,
    ).toBe(first?.id);
  });

  it("does not resolve a branch through another user or project", async () => {
    const store = new InMemoryDocsBranchStore();
    store.addSite("owner", site);
    const branch = await store.getOrCreateHiddenBranch({
      userId: "owner",
      projectId: site.projectId,
    });
    expect(branch).not.toBeNull();
    expect(
      await store.getBranchForUser({
        userId: "other",
        projectId: site.projectId,
        branch: "main",
      }),
    ).toBeNull();
    expect(
      await store.getBranchForUser({
        userId: "owner",
        projectId: "00000000-0000-4000-8000-000000000009",
        branch: "main",
      }),
    ).toBeNull();
    expect(
      await store.listChanges({
        userId: "other",
        projectId: site.projectId,
        branch: "main",
      }),
    ).toEqual([]);
  });
});
