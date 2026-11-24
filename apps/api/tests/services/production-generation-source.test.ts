import { describe, expect, test, vi } from "vitest";
import { GitHubProductionGenerationSource } from "../../src/services/production-generation-source";

const REPOSITORY_URL = "https://api.github.com/repos/doxahq/doxa";

/** GitHub: the commit at `/commits/...`, the repository (with `size`) at the repository URL. */
function githubFetch(options: { commit?: unknown; repository?: unknown; repositoryStatus?: number } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`${REPOSITORY_URL}/commits/`)) {
      return Response.json(options.commit ?? { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } });
    }
    if (url === REPOSITORY_URL) {
      return Response.json(options.repository ?? { size: 2048 }, { status: options.repositoryStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

function sourceWith(fetchRequest: typeof fetch, createInstallationToken = vi.fn(async () => "token")) {
  return new GitHubProductionGenerationSource({
    repositories: {
      getProductionSource: vi.fn(async () => ({
        externalId: "123456",
        owner: "doxahq",
        name: "doxa",
        defaultBranch: "release/v2",
        installationId: "789",
      })),
    },
    createInstallationToken,
    fetch: fetchRequest,
  });
}

describe("GitHub production generation source", () => {
  test("resolves the immutable default-branch commit and the repository size with a repository-scoped token", async () => {
    const fetchRequest = githubFetch();
    const createInstallationToken = vi.fn(async () => "token");
    const source = sourceWith(fetchRequest, createInstallationToken);

    await expect(source.resolveTarget("project-1")).resolves.toEqual({
      revision: "a".repeat(40),
      treeHash: "b".repeat(40),
      sizeKb: 2048,
    });
    expect(createInstallationToken).toHaveBeenCalledTimes(1);
    expect(createInstallationToken).toHaveBeenCalledWith({
      installationId: "789",
      scope: {
        repositoryIds: [123456],
        permissions: {
          contents: "read",
          metadata: "read",
        },
      },
    });
    expect(fetchRequest).toHaveBeenCalledWith(
      `${REPOSITORY_URL}/commits/release%2Fv2`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchRequest).toHaveBeenCalledWith(REPOSITORY_URL, expect.objectContaining({ method: "GET" }));
  });

  test("rejects a response that does not identify an exact commit and tree", async () => {
    const source = sourceWith(githubFetch({ commit: { sha: "a".repeat(40), commit: { tree: { sha: "main" } } } }));

    await expect(source.resolveTarget("project-1")).rejects.toThrow("default branch response was invalid");
  });

  test("fails the start when GitHub does not report the repository size", async () => {
    await expect(sourceWith(githubFetch({ repositoryStatus: 502 })).resolveTarget("project-1")).rejects.toThrow(
      "GitHub repository lookup failed (502).",
    );
    await expect(sourceWith(githubFetch({ repository: { size: "big" } })).resolveTarget("project-1")).rejects.toThrow(
      "GitHub repository response was invalid.",
    );
  });
});
