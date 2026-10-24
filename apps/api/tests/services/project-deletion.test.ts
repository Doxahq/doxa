import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getForUser: vi.fn(),
  hasActiveGeneration: vi.fn(),
  deleteForUser: vi.fn(),
  releaseCustomHostnamesForProject: vi.fn(),
}));
vi.mock("../../src/repositories/projects", () => ({
  ProjectsRepository: class {
    getForUser = mocks.getForUser;
  },
}));
vi.mock("../../src/repositories/project-deletion", async (original) => ({
  ...(await original<typeof import("../../src/repositories/project-deletion")>()),
  ProjectDeletionRepository: class {
    hasActiveGeneration = mocks.hasActiveGeneration;
    deleteForUser = mocks.deleteForUser;
  },
}));
vi.mock("../../src/services/docs-domain-lifecycle", () => ({
  DocsDomainLifecycleService: class {
    releaseCustomHostnamesForProject = mocks.releaseCustomHostnamesForProject;
  },
}));

const { deleteProject } = await import("../../src/services/project-deletion");

const owner = { userId: "user-1", projectId: "project-1" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getForUser.mockResolvedValue({ id: "project-1" });
  mocks.hasActiveGeneration.mockResolvedValue(false);
  mocks.deleteForUser.mockResolvedValue({
    projectId: "project-1",
    siteId: "site-1",
    storageEntryIds: [],
  });
});

describe("deleteProject", () => {
  test("removes the custom hostnames before the rows", async () => {
    const order: string[] = [];
    mocks.releaseCustomHostnamesForProject.mockImplementation(async () => {
      order.push("hostnames");
    });
    mocks.deleteForUser.mockImplementation(async () => {
      order.push("rows");
      return { projectId: "project-1", siteId: "site-1", storageEntryIds: [] };
    });

    await deleteProject({} as never, owner);

    expect(order).toEqual(["hostnames", "rows"]);
    expect(mocks.releaseCustomHostnamesForProject).toHaveBeenCalledWith(owner);
    expect(mocks.deleteForUser).toHaveBeenCalledWith(owner);
  });

  test("touches nothing while a generation runs", async () => {
    mocks.hasActiveGeneration.mockResolvedValue(true);

    await expect(deleteProject({} as never, owner)).rejects.toMatchObject({
      code: "generation_active",
    });
    expect(mocks.releaseCustomHostnamesForProject).not.toHaveBeenCalled();
    expect(mocks.deleteForUser).not.toHaveBeenCalled();
  });

  test("keeps the project when Cloudflare refuses", async () => {
    mocks.releaseCustomHostnamesForProject.mockRejectedValue(
      new Error("Cloudflare is unavailable."),
    );

    await expect(deleteProject({} as never, owner)).rejects.toThrow(
      "Cloudflare is unavailable.",
    );
    expect(mocks.deleteForUser).not.toHaveBeenCalled();
  });

  test("reports a project that the user does not own as not found", async () => {
    mocks.getForUser.mockResolvedValue(null);

    await expect(deleteProject({} as never, owner)).rejects.toMatchObject({
      code: "project_not_found",
    });
    expect(mocks.releaseCustomHostnamesForProject).not.toHaveBeenCalled();
  });
});
