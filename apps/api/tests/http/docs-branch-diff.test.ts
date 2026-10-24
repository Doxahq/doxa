import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";

const mocks = vi.hoisted(() => ({ diff: vi.fn(), pageSources: vi.fn() }));
vi.mock("../../src/services/agent-access/project-access-repository", async () => {
  const { SessionOwnedProjectAccess } = await import("../support/session-owned-project-access");
  return { ProjectAccessRepository: SessionOwnedProjectAccess };
});
vi.mock("../../src/http/auth", () => ({
  withUser: (
    _context: unknown,
    handler: (userId: string) => Promise<Response>,
  ) => handler("owner"),
}));
vi.mock("../../src/services/docs-branches/branch-diff", () => ({
  DocsBranchDiffService: {
    fromEnv: () => ({ diff: mocks.diff, pageSources: mocks.pageSources }),
  },
}));

import { createDocsBranchRoutes } from "../../src/routes/docs-branches";
import { DocsContentError } from "../../src/services/docs-content/errors";

const branchId = "11111111-1111-4111-8111-111111111111";

function get(path: string) {
  const app = createApiRouter();
  app.route("/projects/:projectId/branches", createDocsBranchRoutes());
  return app.request(`http://localhost/projects/11111111-1111-4111-8111-111111111111/branches${path}`);
}

describe("branch diff routes", () => {
  beforeEach(() => {
    mocks.diff.mockReset();
    mocks.pageSources.mockReset();
  });

  test("returns the diff of the user's branch", async () => {
    const diff = { pages: [], structure: [], siteSettings: null, behind: false };
    mocks.diff.mockResolvedValue(diff);

    const response = await get(`/${branchId}/diff`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(diff);
    expect(mocks.diff).toHaveBeenCalledWith({
      userId: "owner",
      projectId: "11111111-1111-4111-8111-111111111111",
      branch: branchId,
    });
  });

  test("returns both sources of one page", async () => {
    mocks.pageSources.mockResolvedValue({ href: "/install", before: "a", after: "b" });

    const response = await get(`/${branchId}/diff/page?href=%2Finstall`);

    expect(response.status).toBe(200);
    expect(mocks.pageSources).toHaveBeenCalledWith({
      userId: "owner",
      projectId: "11111111-1111-4111-8111-111111111111",
      branch: branchId,
      href: "/install",
    });
  });

  test("rejects a page request without a valid href", async () => {
    const response = await get(`/${branchId}/diff/page?href=install`);

    expect(response.status).toBe(400);
    expect(mocks.pageSources).not.toHaveBeenCalled();
  });

  test("answers 404 for an invalid branch ref or an unknown branch", async () => {
    expect((await get("/not-a-branch/diff")).status).toBe(404);
    mocks.diff.mockRejectedValue(
      new DocsContentError("branch_not_found", "Branch not found."),
    );

    const response = await get(`/${branchId}/diff`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { details: { code: "branch_not_found" } },
    });
  });
});
