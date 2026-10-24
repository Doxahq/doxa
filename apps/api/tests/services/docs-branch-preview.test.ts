import { describe, expect, test, vi } from "vitest";
import {
  branchIdSchema,
  siteIdSchema,
  versionIdSchema,
} from "@doxahq/contracts/docs-branches";

import type {
  DocsBranchPreviewStore,
  LockedBranchPreview,
} from "../../src/repositories/docs-branch-preview";
import { isPreviewBuildRateLimited } from "../../src/repositories/docs-branch-preview";
import { DocsBranchPreview } from "../../src/services/docs-branches/preview";
import { createInMemoryDocsContentStore } from "../support/in-memory-docs-content-store";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const siteId = siteIdSchema.parse("33333333-3333-4333-8333-333333333333");
const branchId = branchIdSchema.parse("44444444-4444-4444-8444-444444444444");
const baseVersionId = versionIdSchema.parse(
  "55555555-5555-4555-8555-555555555555",
);
const previewVersionId = "66666666-6666-4666-8666-666666666666";
const hostname = "example-br-feature-0123456789abcdef.doxa.page";

describe("branch preview service", () => {
  test("materializes the locked branch snapshot and returns its channel URL", async () => {
    const context = branchContext();
    const materialize = vi.fn(async () => ({
      artifactPrefix: `sites/${siteId}/versions/${previewVersionId}`,
      manifestPath: `sites/${siteId}/versions/${previewVersionId}/manifest.json`,
      summary: {},
    }));
    const previews: DocsBranchPreviewStore = {
      build: vi.fn(async (input) => {
        await input.materialize(context);
        return { hostname, versionId: input.versionId };
      }),
    };
    const preview = new DocsBranchPreview({
      previews,
      store: emptyContentStore(),
      entitlements: {
        getProjectEntitlements: async () => ({
          removePoweredBy: false,
          maxBranchesPerSite: 10,
        }),
      },
      assets: { head: async () => null },
      docsBaseDomain: "doxa.page",
      docsRendererBaseUrl: undefined,
      createVersionId: () => previewVersionId,
      now: () => new Date("2026-09-24T12:00:00.000Z"),
      materialize,
    });

    await expect(
      preview.build({ userId, projectId, branch: branchId }),
    ).resolves.toEqual({
      url: `https://${hostname}`,
      hostname,
      versionId: previewVersionId,
    });
    expect(materialize).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        projectId,
        projectName: "Example",
        siteId,
        branch: context.branch,
        baseArtifactPrefix: context.baseArtifactPrefix,
        targetVersionId: previewVersionId,
        generatedAt: "2026-09-24T12:00:00.000Z",
      }),
    );
  });
});

describe("branch preview rate limit", () => {
  const lastBuiltAt = new Date("2026-09-24T12:00:00.000Z");

  test.each([
    { elapsedMs: 9_999, limited: true },
    { elapsedMs: 10_000, limited: false },
  ])("returns $limited after $elapsedMs ms", ({ elapsedMs, limited }) => {
    const now = new Date(lastBuiltAt.getTime() + elapsedMs);

    expect(isPreviewBuildRateLimited(lastBuiltAt, now)).toBe(limited);
  });

  test("does not limit the first build", () => {
    expect(isPreviewBuildRateLimited(null, lastBuiltAt)).toBe(false);
  });
});

function branchContext(): LockedBranchPreview {
  return {
    siteId,
    projectName: "Example",
    projectSlug: "example",
    branch: {
      id: branchId,
      siteId,
      kind: "named",
      purpose: "user",
      name: "feature",
      baseVersionId,
      revision: 2,
      previewRevision: null,
      ownerUserId: userId,
      createdFromBranchId: null,
      createdBy: { kind: "user" },
      createdAt: new Date("2026-09-24T10:00:00.000Z"),
      updatedAt: new Date("2026-09-24T11:00:00.000Z"),
    },
    baseArtifactPrefix: `sites/${siteId}/versions/${baseVersionId}`,
    changes: [],
  };
}

function emptyContentStore() {
  return createInMemoryDocsContentStore();
}
