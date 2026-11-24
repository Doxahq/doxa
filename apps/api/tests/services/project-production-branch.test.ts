import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/env";

const mocks = vi.hoisted(() => ({
  getBranchTargetForUser: vi.fn(),
  exists: vi.fn(),
  createForRepository: vi.fn(),
  connectRepository: vi.fn(),
  assertProjectLimit: vi.fn(),
}));

vi.mock("../../src/services/project-limit", () => ({ assertProjectLimit: mocks.assertProjectLimit }));

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
    mocks.assertProjectLimit.mockResolvedValue(undefined);
  });

  test("checks the plan's project limit for the new project's owner first", async () => {
    const team = { id: "22222222-2222-4222-8222-222222222222", name: "Acme Docs" };
    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, team });
    expect(mocks.assertProjectLimit).toHaveBeenCalledWith(env, expect.objectContaining({ userId: "user-1", team }));

    const { PlanLimitError } = await import("@doxahq/billing");
    mocks.createForRepository.mockClear();
    mocks.assertProjectLimit.mockRejectedValueOnce(new PlanLimitError({ key: "account.projects", limit: 1, used: 1 }));
    await expect(
      createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, productionBranch: "dev", team: null }),
    ).rejects.toBeInstanceOf(PlanLimitError);
    expect(mocks.getBranchTargetForUser).not.toHaveBeenCalled();
    expect(mocks.createForRepository).not.toHaveBeenCalled();
  });

  test("connecting a repository to an existing project does not count a new project", async () => {
    await connectProjectRepository(env, { userId: "user-1", projectId: "project-1", githubRepositoryId: repositoryId });
    expect(mocks.assertProjectLimit).not.toHaveBeenCalled();
  });

  test("creates a project that follows the default branch without asking GitHub", async () => {
    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, team: null });

    expect(mocks.getBranchTargetForUser).not.toHaveBeenCalled();
    expect(mocks.createForRepository).toHaveBeenCalledWith({ userId: "user-1", githubRepositoryId: repositoryId, team: null });
  });

  test("passes the authorized team to the new project", async () => {
    const team = { id: "22222222-2222-4222-8222-222222222222", name: "Acme Docs" };
    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, team });

    expect(mocks.createForRepository).toHaveBeenCalledWith(expect.objectContaining({ team }));
  });

  test("does not ask GitHub about the repository's default branch", async () => {
    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, productionBranch: "main", team: null });

    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.createForRepository).toHaveBeenCalledWith(expect.objectContaining({ productionBranch: "main" }));
  });

  test("stores another branch after GitHub confirms it", async () => {
    mocks.exists.mockResolvedValue(true);

    await createRepositoryProject(env, { userId: "user-1", githubRepositoryId: repositoryId, productionBranch: "release", team: null });

    expect(mocks.getBranchTargetForUser).toHaveBeenCalledWith("user-1", repositoryId);
    expect(mocks.exists).toHaveBeenCalledWith(target, "release");
    expect(mocks.createForRepository).toHaveBeenCalledWith(expect.objectContaining({ productionBranch: "release" }));
  });

  test("creates no project for a branch that the repository does not have", async () => {
    mocks.exists.mockResolvedValue(false);

    const created = createRepositoryProject(env, {
      userId: "user-1",
      team: null,
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
