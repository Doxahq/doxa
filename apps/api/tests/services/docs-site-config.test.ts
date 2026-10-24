import { describe, expect, test, vi } from "vitest";
import { validateConfigForSite } from "../../src/services/docs-content/site-config";

describe("site config validation for branch edits", () => {
  const entitlements = {
    getProjectEntitlements: vi.fn(async () => ({
      removePoweredBy: false,
      maxBranchesPerSite: 10,
    })),
  };
  const assets = { head: vi.fn(async () => null) };

  test("returns each plan and asset issue before a working row is written", async () => {
    await expect(
      validateConfigForSite(
        {
          branding: {
            poweredBy: false,
            logo: { light: `asset:${"a".repeat(64)}` },
            favicon: `asset:${"b".repeat(64)}`,
          },
        },
        { projectId: "project", siteId: "site" },
        entitlements,
        assets,
      ),
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({ code: "entitlement_required", path: "/branding/poweredBy" }),
        expect.objectContaining({ code: "asset_not_found", path: "/branding/logo/light" }),
        expect.objectContaining({ code: "asset_not_found", path: "/branding/favicon" }),
      ],
    });
  });

  test("accepts a valid config with the project plan", async () => {
    await expect(
      validateConfigForSite(
        { name: "My docs" },
        { projectId: "project", siteId: "site" },
        entitlements,
        assets,
      ),
    ).resolves.toMatchObject({ name: "My docs" });
  });
});
