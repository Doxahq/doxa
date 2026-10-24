import { describe, expect, test, vi } from "vitest";
import { DocsBranchService } from "../../src/services/docs-branches/branch-service";

describe("DocsBranchService discard", () => {
  test.each(["agent", "mcp"] as const)("rejects %s origin", async (origin) => {
    const discard = vi.fn(async () => ({ revision: 1, collectEntryIds: [] }));
    const service = new DocsBranchService({
      branches: { discard },
      collectStorage: vi.fn(),
    });

    await expect(
      service.discard({
        actor: { userId: "owner", origin },
        projectId: "project",
        branch: "main",
      }),
    ).rejects.toMatchObject({ code: "invalid" });

    expect(discard).not.toHaveBeenCalled();
  });
});

describe("DocsBranchService discard of main", () => {
  test("collects the hidden branch preview after the commit", async () => {
    const collectStorage = vi.fn(async (_entryIds: readonly string[]) => {});
    const service = new DocsBranchService({
      branches: {
        discard: async () => ({ revision: 4, collectEntryIds: ["gc-1"] }),
      },
      collectStorage,
    });

    await expect(
      service.discard({
        actor: { userId: "owner", origin: "editor" },
        projectId: "project",
        branch: "main",
      }),
    ).resolves.toEqual({ revision: 4 });
    expect(collectStorage).toHaveBeenCalledWith(["gc-1"]);
  });
});
