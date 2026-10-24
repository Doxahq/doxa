import { describe, expect, test, vi } from "vitest";
import { isRestorableVersion } from "../../src/repositories/docs-history";
import { DocsBranchHistory } from "../../src/services/docs-branches/history";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const publicationId = "33333333-3333-4333-8333-333333333333";

describe("branch publication history", () => {
  test("does not offer restore when the artifact is missing", async () => {
    const list = vi.fn(async () => ({
      page: {
        publications: [
          {
            id: publicationId,
            kind: "editor" as const,
            versionId: "44444444-4444-4444-8444-444444444444",
            versionNumber: 2,
            actor: null,
            branchName: null,
            summary: {},
            createdAt: "2026-09-24T00:00:00.000Z",
            isCurrent: false,
            canRestore: true,
          },
        ],
        nextCursor: null,
      },
      manifestPaths: new Map([
        [publicationId, "sites/site/versions/old/manifest.json"],
      ]),
    }));
    const service = new DocsBranchHistory(
      {
        list,
        getRestoreCandidate: vi.fn(async () => null),
        restore: vi.fn(async () => ({ publicationId, versionId: "old" })),
      },
      { read: async () => null },
    );
    const page = await service.list({ userId, projectId, limit: 25 });
    expect(page.publications[0]?.canRestore).toBe(false);
  });

  test("rejects a publication that does not belong to the project", async () => {
    const restore = vi.fn(async () => ({ publicationId, versionId: "old" }));
    const service = new DocsBranchHistory(
      {
        list: vi.fn(async () => ({
          page: { publications: [], nextCursor: null },
          manifestPaths: new Map(),
        })),
        getRestoreCandidate: vi.fn(async () => null),
        restore,
      },
      { read: async () => "manifest" },
    );
    await expect(
      service.restore({
        userId,
        projectId,
        publicationId,
        expectedMainVersionId: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(restore).not.toHaveBeenCalled();
  });

  test("refuses a version that the retention policy collected", async () => {
    const restore = vi.fn(async () => ({ publicationId, versionId: "old" }));
    const read = vi.fn(async () => "manifest");
    const service = new DocsBranchHistory(
      {
        list: vi.fn(async () => ({
          page: { publications: [], nextCursor: null },
          manifestPaths: new Map(),
        })),
        getRestoreCandidate: vi.fn(async () => ({
          siteId: "site-1",
          versionId: "old",
          manifestPath: "sites/site/versions/old/manifest.json",
          channel: "production" as const,
          status: "published" as const,
          artifactsCollectedAt: new Date("2026-10-01T00:00:00.000Z"),
          currentVersionId: "current",
        })),
        restore,
      },
      { read },
    );
    await expect(
      service.restore({
        userId,
        projectId,
        publicationId,
        expectedMainVersionId: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("no longer restorable"),
    });
    expect(read).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("restorable versions", () => {
  test("needs a published production version that is not current or collected", () => {
    const version = {
      channel: "production" as const,
      status: "published" as const,
      artifactsCollectedAt: null,
      isCurrent: false,
    };
    expect(isRestorableVersion(version)).toBe(true);
    expect(isRestorableVersion({ ...version, isCurrent: true })).toBe(false);
    expect(isRestorableVersion({ ...version, channel: "preview" })).toBe(false);
    expect(
      isRestorableVersion({ ...version, artifactsCollectedAt: new Date() }),
    ).toBe(false);
  });
});
