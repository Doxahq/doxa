import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GitHubAuthorizationError,
  GitHubRepositoryListError,
  createInstallationAccessToken,
  fetchRepositoryDefaultBranch,
  exchangeUserAuthorizationCode,
  fetchGitHubTokenUser,
  findUserInstallation,
  listInstallationRepositories,
  listUserInstallationRepositories,
} from "../../src/services/github-app";

describe("createInstallationAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("uses local token for local installations", async () => {
    await expect(
      createInstallationAccessToken({ LOCAL_GITHUB_TOKEN: "ghs_local" } as never, "local-dev", null),
    ).resolves.toEqual({ token: "ghs_local", expiresAt: null });
  });

  test("fails clearly when local token is missing", async () => {
    await expect(createInstallationAccessToken({} as never, "local-dev", null)).rejects.toThrow(
      "LOCAL_GITHUB_TOKEN is required for local repository generation.",
    );
  });

  test("never asks GitHub for a token without a repository scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createInstallationAccessToken({} as never, "456", null)).rejects.toThrow(
      "A GitHub installation token must be limited to repositories.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listInstallationRepositories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("maps GitHub repository payloads into platform repository fields", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        repositories: [
          {
            id: 42,
            full_name: "doxahq/doxa",
            name: "doxa",
            private: true,
            default_branch: "main",
            owner: { login: "doxahq" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listInstallationRepositories("ghs_installation")).resolves.toEqual([
      {
        githubRepoId: "42",
        fullName: "doxahq/doxa",
        owner: "doxahq",
        name: "doxa",
        defaultBranch: "main",
        isPrivate: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/installation/repositories?per_page=100",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ghs_installation" }),
      }),
    );
  });

  test("throws on GitHub API failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "bad" }, { status: 403 })));

    await expect(listInstallationRepositories("bad-token")).rejects.toThrow(
      "GitHub installation repositories request failed (403).",
    );
  });
});

describe("exchangeUserAuthorizationCode", () => {
  const env = { GITHUB_CLIENT_ID: "Iv1.client", GITHUB_CLIENT_SECRET: "client-secret" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("exchanges the code with the redirect URI of the authorize request", async () => {
    const fetchMock = vi.fn(async () => Response.json({ access_token: "ghu_user" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeUserAuthorizationCode(env, "code-1", "https://api.doxa.so/github/install/authorize"),
    ).resolves.toBe("ghu_user");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "Iv1.client",
          client_secret: "client-secret",
          code: "code-1",
          redirect_uri: "https://api.doxa.so/github/install/authorize",
        }),
      }),
    );
  });

  test("fails with the GitHub error code when GitHub refuses the code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "bad_verification_code" })));

    const result = exchangeUserAuthorizationCode(env, "used-code", "https://api.doxa.so/github/install/authorize");
    await expect(result).rejects.toBeInstanceOf(GitHubAuthorizationError);
    await expect(result).rejects.toThrow("GitHub user authorization failed (bad_verification_code).");
  });
});

describe("findUserInstallation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("finds the installation on a later page with the user's token", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { login: `account-${index}`, type: "User" },
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ installations: firstPage }))
      .mockResolvedValueOnce(
        Response.json({ installations: [{ id: 4242, account: { id: 900, login: "acme", type: "Organization" } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(findUserInstallation("ghu_user", "4242")).resolves.toEqual({
      installationId: "4242",
      accountId: "900",
      accountLogin: "acme",
      accountType: "Organization",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.github.com/user/installations?per_page=100&page=2",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ghu_user" }),
      }),
    );
  });

  test("returns null when the user cannot access the installation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ installations: [{ id: 1, account: { login: "me", type: "User" } }] })),
    );

    await expect(findUserInstallation("ghu_user", "4242")).resolves.toBeNull();
  });
});

describe("listUserInstallationRepositories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("lists only the repositories that the user's token can see", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        repositories: [
          { id: 7, full_name: "acme/docs", name: "docs", private: true, owner: { login: "acme" } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listUserInstallationRepositories("ghu_user", "4242")).resolves.toEqual({
      repositories: [
        {
          githubRepoId: "7",
          fullName: "acme/docs",
          owner: "acme",
          name: "docs",
          defaultBranch: "main",
          isPrivate: true,
        },
      ],
      complete: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/installations/4242/repositories?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ghu_user" }),
      }),
    );
  });

  test("reports an incomplete list when it stops at the page cap", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      full_name: `acme/repo-${index}`,
      name: `repo-${index}`,
      private: false,
      owner: { login: "acme" },
    }));
    const fetchMock = vi.fn(async () => Response.json({ repositories: fullPage }));
    vi.stubGlobal("fetch", fetchMock);

    const listed = await listUserInstallationRepositories("ghu_user", "4242");

    expect(listed.complete).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  test("stops before the next page when the user's GitHub budget is below the floor", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      full_name: `acme/repo-${index}`,
      name: `repo-${index}`,
      private: false,
      owner: { login: "acme" },
    }));
    const fetchMock = vi.fn(async () =>
      Response.json({ repositories: fullPage }, { headers: { "x-ratelimit-remaining": "499" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const listed = await listUserInstallationRepositories("ghu_user", "4242", { minRateLimitRemaining: 500 });

    expect(listed).toMatchObject({ complete: false });
    expect(listed.repositories).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a last page below the floor still makes a complete list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ repositories: [] }, { headers: { "x-ratelimit-remaining": "3" } }),
    ));

    await expect(
      listUserInstallationRepositories("ghu_user", "4242", { minRateLimitRemaining: 500 }),
    ).resolves.toEqual({ repositories: [], complete: true });
  });

  test("a rate limit gives a typed error with the seconds until the reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
    const reset = Math.floor(new Date("2026-11-23T12:10:00Z").getTime() / 1000);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("API rate limit exceeded", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
    ));

    const failure = await listUserInstallationRepositories("ghu_user", "4242").catch((caught: unknown) => caught);
    vi.useRealTimers();

    expect(failure).toBeInstanceOf(GitHubRepositoryListError);
    expect(failure).toMatchObject({ status: 403, rateLimited: true, retryAfterSeconds: 600 });
    expect((failure as GitHubRepositoryListError).isAuthorizationRefusal).toBe(false);
  });

  test("a refused token is an authorization refusal, not a rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad credentials", { status: 401 })));

    const failure = await listUserInstallationRepositories("ghu_user", "4242").catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ status: 401, rateLimited: false, retryAfterSeconds: null });
    expect((failure as GitHubRepositoryListError).isAuthorizationRefusal).toBe(true);
  });
});

describe("fetchRepositoryDefaultBranch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("reads the default branch with a token of that repository only", async () => {
    // A local installation uses LOCAL_GITHUB_TOKEN, so the read is the only request.
    const fetchMock = vi.fn(async () => Response.json({ id: 333, default_branch: "trunk" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchRepositoryDefaultBranch({ LOCAL_GITHUB_TOKEN: "ghs_local" } as never, "local-dev", "333"),
    ).resolves.toBe("trunk");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repositories/333",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer ghs_local" }) }),
    );
  });

  test("throws when GitHub refuses the read, and returns null without a branch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    await expect(
      fetchRepositoryDefaultBranch({ LOCAL_GITHUB_TOKEN: "ghs_local" } as never, "local-dev", "333"),
    ).rejects.toThrow("(404)");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 333 })));
    await expect(
      fetchRepositoryDefaultBranch({ LOCAL_GITHUB_TOKEN: "ghs_local" } as never, "local-dev", "333"),
    ).resolves.toBeNull();
  });
});

describe("fetchGitHubTokenUser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns the GitHub user of the token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 5150, login: "octo-admin" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubTokenUser("ghu_user")).resolves.toEqual({ githubUserId: "5150", login: "octo-admin" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer ghu_user" }) }),
    );
  });

  test("throws when GitHub fails or sends no id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    await expect(fetchGitHubTokenUser("ghu_user")).rejects.toThrow("(500)");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ login: "x" })));
    await expect(fetchGitHubTokenUser("ghu_user")).rejects.toThrow("no id");
  });
});
