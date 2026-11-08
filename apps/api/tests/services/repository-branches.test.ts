import { describe, expect, test, vi } from "vitest";
import { InstallationTokenRequestError } from "../../src/services/github-app";
import {
  RepositoryBranchesService,
  RepositoryBranchesUnavailableError,
  type RepositoryBranchTarget,
} from "../../src/services/repository-branches";

const target: RepositoryBranchTarget = {
  externalId: "123456",
  owner: "doxahq",
  name: "doxa",
  installationId: "789",
  defaultBranch: "main",
};

function branchPage(names: readonly string[]): Response {
  return Response.json(names.map((name) => ({ name, commit: { sha: "a".repeat(40) } })));
}

function service(fetchRequest: typeof fetch, createReadToken = vi.fn(async () => "token")) {
  return {
    createReadToken,
    branches: new RepositoryBranchesService({ createReadToken, fetch: fetchRequest }),
  };
}

describe("repository branches", () => {
  test("lists the default branch first and stops at a short page", async () => {
    const fetchRequest = vi.fn(async () => branchPage(["develop", "main", "release/2.x"]));
    const { branches, createReadToken } = service(fetchRequest);

    await expect(branches.list(target)).resolves.toEqual({
      defaultBranch: "main",
      branches: ["main", "develop", "release/2.x"],
      complete: true,
    });
    expect(createReadToken).toHaveBeenCalledWith(target);
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(fetchRequest).toHaveBeenCalledWith(
      "https://api.github.com/repos/doxahq/doxa/branches?per_page=100&page=1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("marks a list cut at the page limit as incomplete", async () => {
    let page = 0;
    const fetchRequest = vi.fn(async () => {
      page += 1;
      return branchPage(Array.from({ length: 100 }, (_, index) => `b-${page}-${index}`));
    });
    const { branches } = service(fetchRequest);

    const listed = await branches.list(target);

    expect(fetchRequest).toHaveBeenCalledTimes(10);
    expect(listed.complete).toBe(false);
    // The default branch leads even when the cut list does not hold it.
    expect(listed.branches[0]).toBe("main");
    expect(listed.branches).toHaveLength(1001);
  });

  test("answers a local installation without GitHub", async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const { branches } = service(fetchRequest);
    const local = { ...target, installationId: "local-dev" };

    await expect(branches.list(local)).resolves.toEqual({
      defaultBranch: "main",
      branches: ["main"],
      complete: false,
    });
    await expect(branches.exists(local, "anything")).resolves.toBe(true);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("finds a branch with slashes in its name", async () => {
    const fetchRequest = vi.fn(async () => Response.json({ name: "release/2.x" }));
    const { branches } = service(fetchRequest);

    await expect(branches.exists(target, "release/2.x")).resolves.toBe(true);
    expect(fetchRequest).toHaveBeenCalledWith(
      "https://api.github.com/repos/doxahq/doxa/branches/release/2.x",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("does not accept a missing branch or the old name of a renamed one", async () => {
    const missing = service(vi.fn(async () => new Response("Not Found", { status: 404 })));
    const renamed = service(vi.fn(async () => Response.json({ name: "trunk" })));

    await expect(missing.branches.exists(target, "gone")).resolves.toBe(false);
    await expect(renamed.branches.exists(target, "master")).resolves.toBe(false);
  });

  test("reports a GitHub failure apart from a missing branch", async () => {
    const outage = service(vi.fn(async () => new Response("Unavailable", { status: 503 })));
    const refusedToken = service(
      vi.fn<typeof fetch>(),
      vi.fn(async () => {
        throw new InstallationTokenRequestError(404);
      }),
    );

    await expect(outage.branches.exists(target, "main")).rejects.toBeInstanceOf(RepositoryBranchesUnavailableError);
    await expect(outage.branches.list(target)).rejects.toBeInstanceOf(RepositoryBranchesUnavailableError);
    await expect(refusedToken.branches.list(target)).rejects.toBeInstanceOf(RepositoryBranchesUnavailableError);
  });
});
