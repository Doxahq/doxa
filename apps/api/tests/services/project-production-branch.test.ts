import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/env";

const mocks = vi.hoisted(() => ({
  getBranchTargetForUser: vi.fn(),
  exists: vi.fn(),
  createForRepository: vi.fn(),
  connectRepository: vi.fn(),
}));

vi.mock("../../src/repositories/github", () => ({
  GitHubRepository: vi.fn(() => ({ getBranchTargetForUser: mocks.getBranchTargetForUser })),
}));

vi.mock("../../src/services/repository-branches", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/repository-branches")>();
  return {
    ...actual,
    RepositoryBranchesService: { fromEnv: vi.fn(() => ({ exists: mocks.exists })) },
  };
});

vi.mock("../../src/repositories/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/projects")>();
  return {
    ...actual,
    ProjectsRepository: vi.fn(() => ({
      createForRepository: mocks.createForRepository,
      connectRepository: mocks.connectRepository,
    })),
  };
});

import { CreateProjectError } from "../../src/repositories/projects";
import {
  connectProjectRepository,
  createRepositoryProject,
} from "../../src/services/project-production-branch";
import { RepositoryBranchesUnavailableError } from "../../src/services/repository-branches";

// Every dependency that reads the environment is mocked.
const env = {} as Env;
const repositoryId = "11111111-1111-4111-8111-111111111111";
const target = {
  externalId: "123456",
  owner: "doxahq",
  name: "doxa",
  installationId: "789",
  defaultBranch: "main",
};

describe("project production branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBranchTargetForUser.mockResolvedValue(target);
    mocks.createForRepository.mockResolvedValue({ id: "project-1" });
    mocks.connectRepository.mockResolvedValue({ id: "project-1" });
  });

  test("creates a project that follows the default branch without asking GitHub", async () => {
    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId });

    expect(mocks.getBranchTargetForUser).not.toHaveBeenCalled();
    expect(mocks.createForRepository).toHaveBeenCalledWith({ userId: "user-1", githubRepositoryId: repositoryId });
  });

  test("does not ask GitHub about the repository's default branch", async () => {
    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, productionBranch: "main" });

    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.createForRepository).toHaveBeenCalledWith(expect.objectContaining({ productionBranch: "main" }));
  });

  test("stores another branch after GitHub confirms it", async () => {
    mocks.exists.mockResolvedValue(true);

    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, productionBranch: "release" });

    expect(mocks.getBranchTargetForUser).toHaveBeenCalledWith("user-1", repositoryId);
    expect(mocks.exists).toHaveBeenCalledWith(target, "release");
    expect(mocks.createForRepository).toHaveBeenCalledWith(expect.objectContaining({ productionBranch: "release" }));
  });

  test("creates no project for a branch that the repository does not have", async () => {
    mocks.exists.mockResolvedValue(false);

    const created = createRepositoryProject(env, {
      userId: "user-1",
      githubRepositoryId: repositoryId,
      productionBranch: "gone",
    });

    await expect(created).rejects.toBeInstanceOf(CreateProjectError);
    await expect(created).rejects.toMatchObject({ code: "branch_not_found" });
    expect(mocks.createForRepository).not.toHaveBeenCalled();
  });

  test("reports a GitHub outage apart from a missing branch", async () => {
    mocks.exists.mockRejectedValue(new RepositoryBranchesUnavailableError(503));

    await expect(
      connectProjectRepository(env, {
        userId: "user-1",
        projectId: "project-1",
        githubRepositoryId: repositoryId,
        productionBranch: "release",
      }),
    ).rejects.toMatchObject({ code: "branch_check_unavailable" });
    expect(mocks.connectRepository).not.toHaveBeenCalled();
  });

  test("leaves an unknown repository to the project write, which refuses it", async () => {
    mocks.getBranchTargetForUser.mockResolvedValue(null);

    await connectProjectRepository(env, {
      userId: "user-1",
      projectId: "project-1",
      githubRepositoryId: repositoryId,
      productionBranch: "release",
    });

    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.connectRepository).toHaveBeenCalledWith(expect.objectContaining({ productionBranch: "release" }));
  });
});
