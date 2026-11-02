import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GitHubAuthorizationError,
  createInstallationAccessToken,
  exchangeUserAuthorizationCode,
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
      createInstallationAccessToken({ LOCAL_GITHUB_TOKEN: "ghs_local" } as never, "local-dev"),
    ).resolves.toEqual({ token: "ghs_local", expiresAt: null });
  });

  test("fails clearly when local token is missing", async () => {
    await expect(createInstallationAccessToken({} as never, "local-dev")).rejects.toThrow(
      "LOCAL_GITHUB_TOKEN is required for local repository generation.",
    );
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
        Response.json({ installations: [{ id: 4242, account: { login: "acme", type: "Organization" } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(findUserInstallation("ghu_user", "4242")).resolves.toEqual({
      installationId: "4242",
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
});
