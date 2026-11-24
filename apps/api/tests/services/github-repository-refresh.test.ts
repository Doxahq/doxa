import type { GitHubRepositoryDto } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";
import { refreshRetryAfterSeconds, type RepositoryRefreshClaim } from "../../src/repositories/github";
import { GitHubRepositoryListError, type UserInstallationRepositories } from "../../src/services/github-app";
import {
  GitHubRepositoryRefreshService,
  REPOSITORY_REFRESH_COOLDOWN_SECONDS,
  REPOSITORY_REFRESH_RATE_LIMIT_FLOOR,
  repositoryRefreshResponse,
  type RepositoryRefreshDependencies,
} from "../../src/services/github-repository-refresh";

const now = new Date("2026-11-23T12:00:00Z");
const userId = "user-1";

const storedList: GitHubRepositoryDto[] = [
  {
    id: "row-1",
    githubRepoId: "222",
    fullName: "ipenywis/react-email",
    owner: "ipenywis",
    name: "react-email",
    defaultBranch: "canary",
    isPrivate: false,
  },
];

function listed(count: number, complete = true): UserInstallationRepositories {
  return {
    complete,
    repositories: Array.from({ length: count }, (_, index) => ({
      githubRepoId: String(index + 1),
      fullName: `ipenywis/repo-${index}`,
      owner: "ipenywis",
      name: `repo-${index}`,
      defaultBranch: "main",
      isPrivate: false,
    })),
  };
}

function createService(overrides: Partial<RepositoryRefreshDependencies> = {}) {
  const mocks = {
    installations: {
      listRefreshableInstallations: vi.fn(async () => [{ id: "inst-row-1", installationId: "4242" }]),
      claimRepositoryRefresh: vi.fn(async (): Promise<RepositoryRefreshClaim> => ({ claimed: true })),
    },
    repositories: {
      recordRepository: vi.fn(async () => null),
      listReposForUser: vi.fn(async () => storedList),
    },
    userToken: vi.fn(async (): Promise<string | null> => "ghu_user"),
    listRepositories: vi.fn(async (): Promise<UserInstallationRepositories> => listed(2)),
    now: () => now,
  };
  const dependencies: RepositoryRefreshDependencies = { ...mocks, ...overrides };
  // The mocks that an override replaced are not the ones in use.
  return { service: new GitHubRepositoryRefreshService(dependencies), dependencies: mocks };
}

describe("GitHub repository refresh", () => {
  test("reads the list with the user's sign-in token, stores every row, and returns the stored list", async () => {
    const { service, dependencies } = createService();

    await expect(service.refresh(userId)).resolves.toEqual({
      kind: "refreshed",
      repositories: storedList,
      complete: true,
    });
    expect(dependencies.installations.claimRepositoryRefresh).toHaveBeenCalledWith(
      "inst-row-1",
      now,
      REPOSITORY_REFRESH_COOLDOWN_SECONDS,
    );
    expect(dependencies.listRepositories).toHaveBeenCalledWith("ghu_user", "4242", {
      minRateLimitRemaining: REPOSITORY_REFRESH_RATE_LIMIT_FLOOR,
    });
    expect(dependencies.repositories.recordRepository).toHaveBeenCalledTimes(2);
    expect(dependencies.repositories.recordRepository).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "inst-row-1", githubRepoId: "1", fullName: "ipenywis/repo-0" }),
    );
  });

  test("a list cut at the floor or the page cap is reported as incomplete", async () => {
    const { service } = createService({ listRepositories: vi.fn(async () => listed(100, false)) });

    await expect(service.refresh(userId)).resolves.toMatchObject({ kind: "refreshed", complete: false });
  });

  test("a click in the cooldown makes no GitHub request and says when to try again", async () => {
    const { service, dependencies } = createService();
    dependencies.installations.claimRepositoryRefresh.mockResolvedValue({ claimed: false, retryAfterSeconds: 42 });

    await expect(service.refresh(userId)).resolves.toEqual({ kind: "cooldown", retryAfterSeconds: 42 });
    expect(dependencies.listRepositories).not.toHaveBeenCalled();
    expect(dependencies.repositories.recordRepository).not.toHaveBeenCalled();
  });

  test("without an installation, the refresh asks the user to connect GitHub and reads no token", async () => {
    const { service, dependencies } = createService();
    dependencies.installations.listRefreshableInstallations.mockResolvedValue([]);

    await expect(service.refresh(userId)).resolves.toEqual({ kind: "not_connected" });
    expect(dependencies.userToken).not.toHaveBeenCalled();
  });

  test("a local installation has no GitHub list to read", async () => {
    const { service, dependencies } = createService();
    dependencies.installations.listRefreshableInstallations.mockResolvedValue([
      { id: "inst-local", installationId: "local-dev" },
    ]);

    await expect(service.refresh(userId)).resolves.toEqual({ kind: "not_connected" });
  });

  test("without a GitHub sign-in token, nothing is claimed or read", async () => {
    const { service, dependencies } = createService({ userToken: vi.fn(async () => null) });

    await expect(service.refresh(userId)).resolves.toEqual({ kind: "sign_in_unavailable" });
    expect(dependencies.installations.claimRepositoryRefresh).not.toHaveBeenCalled();
    expect(dependencies.listRepositories).not.toHaveBeenCalled();
  });

  test("a token that GitHub refuses asks for another way to update the list", async () => {
    const { service } = createService({
      listRepositories: vi.fn(async () => {
        throw new GitHubRepositoryListError(403, false);
      }),
    });

    await expect(service.refresh(userId)).resolves.toEqual({ kind: "sign_in_unavailable" });
  });

  test("a GitHub rate limit stops the refresh with the reset time", async () => {
    const { service } = createService({
      listRepositories: vi.fn(async () => {
        throw new GitHubRepositoryListError(403, true, 600);
      }),
    });

    await expect(service.refresh(userId)).resolves.toEqual({ kind: "rate_limited", retryAfterSeconds: 600 });
  });

  test("an installation that GitHub hides from the user is skipped; the others refresh", async () => {
    const { service, dependencies } = createService();
    dependencies.installations.listRefreshableInstallations.mockResolvedValue([
      { id: "inst-row-1", installationId: "4242" },
      { id: "inst-row-2", installationId: "5353" },
    ]);
    dependencies.listRepositories
      .mockRejectedValueOnce(new GitHubRepositoryListError(404, false))
      .mockResolvedValueOnce(listed(1));

    await expect(service.refresh(userId)).resolves.toMatchObject({ kind: "refreshed", complete: false });
    expect(dependencies.repositories.recordRepository).toHaveBeenCalledTimes(1);
    expect(dependencies.repositories.recordRepository).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "inst-row-2" }),
    );
  });

  test("another GitHub failure is reported as unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { service } = createService({
      listRepositories: vi.fn(async () => {
        throw new GitHubRepositoryListError(502, false);
      }),
    });

    await expect(service.refresh(userId)).resolves.toEqual({ kind: "github_unavailable" });
    error.mockRestore();
  });

  test("rows are written in batches, never all at the same time", async () => {
    let open = 0;
    let mostOpen = 0;
    const { service } = createService({
      listRepositories: vi.fn(async () => listed(60)),
      repositories: {
        recordRepository: vi.fn(async () => {
          open += 1;
          mostOpen = Math.max(mostOpen, open);
          await Promise.resolve();
          open -= 1;
          return null;
        }),
        listReposForUser: vi.fn(async () => storedList),
      },
    });

    await service.refresh(userId);

    expect(mostOpen).toBeLessThanOrEqual(25);
  });
});

describe("refresh cooldown time", () => {
  test("counts the seconds left of the cooldown, at least 1", () => {
    expect(refreshRetryAfterSeconds(new Date("2026-11-23T11:59:30Z"), now, 60)).toBe(30);
    expect(refreshRetryAfterSeconds(new Date("2026-11-23T11:59:00Z"), now, 60)).toBe(1);
    expect(refreshRetryAfterSeconds(null, now, 60)).toBe(60);
  });
});

describe("repository refresh responses", () => {
  test("a refresh returns the list and is never cached", async () => {
    const response = repositoryRefreshResponse({ kind: "refreshed", repositories: storedList, complete: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ repositories: storedList, complete: true });
  });

  test("a cooldown is a 429 with Retry-After", async () => {
    const response = repositoryRefreshResponse({ kind: "cooldown", retryAfterSeconds: 42 });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { code: "refresh_cooldown", retryAfterSeconds: 42 } },
    });
  });

  test.each([
    [{ kind: "not_connected" } as const, 409, "github_not_connected"],
    [{ kind: "sign_in_unavailable" } as const, 409, "github_sign_in_unavailable"],
    [{ kind: "rate_limited", retryAfterSeconds: null } as const, 429, "github_rate_limited"],
    [{ kind: "github_unavailable" } as const, 502, "github_unavailable"],
  ])("%o answers %i with code %s", async (result, status, code) => {
    const response = repositoryRefreshResponse(result);

    expect(response.status).toBe(status);
    expect(response.headers.has("retry-after")).toBe(false);
    await expect(response.json()).resolves.toMatchObject({ error: { details: { code } } });
  });
});
