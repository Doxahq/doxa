import { afterEach, describe, expect, test, vi } from "vitest";
import { createInstallationAccessToken, listInstallationRepositories } from "../../src/services/github-app";

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
