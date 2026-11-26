import { describe, expect, test, vi } from "vitest";
import { GitHubRepositoryPermissions } from "../../src/services/doxabot/github-repository-permissions";
import {
  PREVIEW_CHECK_CLOSE_GRACE_MS,
  PREVIEW_CHECK_GIVE_UP_MS,
  PREVIEW_CHECK_SWEEP_BATCH,
  PreviewCheckSweeper,
} from "../../src/services/doxabot/preview-check-sweep";

describe("closing the open checks of ended preview jobs", () => {
  const now = new Date("2026-11-25T18:00:00.000Z");

  function sweeperWith(jobIds: string[], close: (jobId: string) => Promise<boolean>) {
    const listOpenReviewRunsOfEndedJobs = vi.fn(async () => jobIds);
    const closeForEndedJob = vi.fn(close);
    const log = vi.fn();
    const sweeper = new PreviewCheckSweeper({
      jobs: { listOpenReviewRunsOfEndedJobs },
      checks: { closeForEndedJob },
      now: () => now,
      log,
    });
    return { sweeper, listOpenReviewRunsOfEndedJobs, closeForEndedJob, log };
  }

  test("asks for jobs that ended after the grace time and within the last day", async () => {
    const { sweeper, listOpenReviewRunsOfEndedJobs } = sweeperWith([], async () => true);

    await sweeper.run();

    expect(listOpenReviewRunsOfEndedJobs).toHaveBeenCalledWith({
      endedAfter: new Date(now.getTime() - PREVIEW_CHECK_GIVE_UP_MS),
      endedBefore: new Date(now.getTime() - PREVIEW_CHECK_CLOSE_GRACE_MS),
      limit: PREVIEW_CHECK_SWEEP_BATCH,
    });
  });

  test("closes each check, and one failure does not stop the others", async () => {
    const { sweeper, closeForEndedJob, log } = sweeperWith(["job-1", "job-2", "job-3"], async (jobId) => {
      if (jobId === "job-2") throw new Error("GitHub check run update failed (502).");
      return true;
    });

    await expect(sweeper.run()).resolves.toEqual({ closed: 2, failed: 1 });

    expect(closeForEndedJob.mock.calls.map(([jobId]) => jobId)).toEqual(["job-1", "job-2", "job-3"]);
    expect(log).toHaveBeenCalledWith("preview_check_close_failed", {
      jobId: "job-2",
      message: "GitHub check run update failed (502).",
    });
    expect(log).toHaveBeenCalledWith("preview_check_sweep", { found: 3, closed: 2, failed: 1 });
  });

  test("counts a job that had nothing to close as neither closed nor failed", async () => {
    const { sweeper } = sweeperWith(["job-1"], async () => false);

    await expect(sweeper.run()).resolves.toEqual({ closed: 0, failed: 0 });
  });

  test("logs nothing when no check is open", async () => {
    const { sweeper, log } = sweeperWith([], async () => true);

    await sweeper.run();

    expect(log).not.toHaveBeenCalled();
  });
});

describe("GitHub write access of the person who presses Retry", () => {
  const lookup = {
    repositoryOwner: "doxahq",
    repositoryName: "doxa",
    repositoryExternalId: "123456",
    installationExternalId: "789",
    login: "maintainer",
  };

  function permissionsWith(response: Response) {
    const createInstallationToken = vi.fn(async () => "ghs_scoped");
    const fetchMock = vi.fn(async () => response);
    const permissions = new GitHubRepositoryPermissions({ createInstallationToken, fetch: fetchMock });
    return { permissions, createInstallationToken, fetchMock };
  }

  test("asks GitHub with a token that can only read the repository's metadata", async () => {
    const { permissions, createInstallationToken, fetchMock } = permissionsWith(Response.json({ permission: "write" }));

    await expect(permissions.canWrite(lookup)).resolves.toBe(true);

    expect(createInstallationToken).toHaveBeenCalledWith({
      installationId: "789",
      scope: { repositoryIds: [123456], permissions: { metadata: "read" } },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/doxahq/doxa/collaborators/maintainer/permission",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test.each([
    ["admin", true],
    ["write", true],
    ["read", false],
    ["none", false],
  ])("a %s permission can write: %s", async (permission, expected) => {
    const { permissions } = permissionsWith(Response.json({ permission, role_name: permission }));

    await expect(permissions.canWrite(lookup)).resolves.toBe(expected);
  });

  test("a person who is not a collaborator cannot write", async () => {
    const { permissions } = permissionsWith(new Response("Not Found", { status: 404 }));

    await expect(permissions.canWrite(lookup)).resolves.toBe(false);
  });

  test("throws when GitHub does not answer, so the caller can tell no from unknown", async () => {
    await expect(
      permissionsWith(new Response("Bad gateway", { status: 502 })).permissions.canWrite(lookup),
    ).rejects.toThrow("GitHub collaborator permission lookup failed (502).");
    await expect(
      permissionsWith(Response.json({ permission: "owner" })).permissions.canWrite(lookup),
    ).rejects.toThrow("GitHub collaborator permission response was not understood.");
  });

  test("escapes the login in the URL", async () => {
    const { permissions, fetchMock } = permissionsWith(Response.json({ permission: "read" }));

    await permissions.canWrite({ ...lookup, login: "../admin" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/doxahq/doxa/collaborators/..%2Fadmin/permission",
      expect.anything(),
    );
  });
});
