import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const mocks = vi.hoisted(() => ({
  getBranchTargetForUser: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler("user-1"),
}));

vi.mock("../../src/repositories/github", () => ({
  GitHubRepository: class {
    getBranchTargetForUser = mocks.getBranchTargetForUser;
  },
}));

vi.mock("../../src/services/repository-branches", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/repository-branches")>();
  return {
    ...actual,
    RepositoryBranchesService: { fromEnv: () => ({ list: mocks.list }) },
  };
});

import { createGitHubRoutes } from "../../src/routes/github";
import { RepositoryBranchesUnavailableError } from "../../src/services/repository-branches";

const app = createGitHubRoutes();
const repositoryId = "11111111-1111-4111-8111-111111111111";
const target = { externalId: "1", owner: "doxahq", name: "doxa", installationId: "7", defaultBranch: "main" };

function listBranches(id: string) {
  return Promise.resolve(app.request(`https://api.doxa.so/repos/${id}/branches`, undefined, {}));
}

describe("GET /github/repos/:repositoryId/branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("lists the branches of a repository of the user's own installation", async () => {
    mocks.getBranchTargetForUser.mockResolvedValue(target);
    mocks.list.mockResolvedValue({ defaultBranch: "main", branches: ["main", "release"], complete: true });

    const response = await listBranches(repositoryId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      defaultBranch: "main",
      branches: ["main", "release"],
      complete: true,
    });
    expect(mocks.getBranchTargetForUser).toHaveBeenCalledWith("user-1", repositoryId);
    expect(mocks.list).toHaveBeenCalledWith(target);
  });

  test("answers 404 for a repository of another user, without asking GitHub", async () => {
    mocks.getBranchTargetForUser.mockResolvedValue(null);

    const response = await listBranches(repositoryId);

    expect(response.status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  test("answers 404 for an ID that is not a UUID, without a query", async () => {
    const response = await listBranches("not-a-uuid");

    expect(response.status).toBe(404);
    expect(mocks.getBranchTargetForUser).not.toHaveBeenCalled();
  });

  test("answers 502 when GitHub cannot list the branches", async () => {
    mocks.getBranchTargetForUser.mockResolvedValue(target);
    mocks.list.mockRejectedValue(new RepositoryBranchesUnavailableError(503));

    const response = await listBranches(repositoryId);

    expect(response.status).toBe(502);
  });
});
