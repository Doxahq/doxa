import { describe, expect, test, vi } from "vitest";
import { GitHubProductionGenerationSource } from "../../src/services/production-generation-source";

describe("GitHub production generation source", () => {
  test("resolves the immutable default-branch commit with a repository-scoped token", async () => {
    const fetchRequest = vi.fn(async () =>
      Response.json({
        sha: "a".repeat(40),
        commit: { tree: { sha: "b".repeat(40) } },
      })
    );
    const createInstallationToken = vi.fn(async () => "token");
    const source = new GitHubProductionGenerationSource({
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

    await expect(
      source.resolveTarget("project-1"),
    ).resolves.toEqual({
      revision: "a".repeat(40),
      treeHash: "b".repeat(40),
    });
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
      "https://api.github.com/repos/doxahq/doxa/commits/release%2Fv2",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("rejects a response that does not identify an exact commit and tree", async () => {
    const source = new GitHubProductionGenerationSource({
      repositories: {
        getProductionSource: vi.fn(async () => ({
          externalId: "123456",
          owner: "doxahq",
          name: "doxa",
          defaultBranch: "main",
          installationId: "789",
        })),
      },
      createInstallationToken: vi.fn(async () => "token"),
      fetch: vi.fn(async () => Response.json({
        sha: "a".repeat(40),
        commit: { tree: { sha: "main" } },
      })),
    });

    await expect(
      source.resolveTarget("project-1"),
    ).rejects.toThrow("default branch response was invalid");
  });
});
