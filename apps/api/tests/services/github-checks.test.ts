import {
  createReviewRunInputSchema,
  updateReviewRunInputSchema,
  type CreateReviewRunInput,
} from "@doxahq/contracts";
import type {
  ReviewRunClaim,
  ReviewRunJobContext,
  ReviewRunJobsStore,
} from "../../src/repositories/jobs";
import {
  DOXA_DOCUMENTATION_PREVIEW_CHECK,
  GitHubChecksAdapter,
} from "../../src/services/doxabot/github-checks";
import {
  mapDoxabotReviewRunState,
  ReviewRunsService,
  type ReviewRunProviderAdapter,
} from "../../src/services/doxabot/review-runs";
import { afterEach, describe, expect, test, vi } from "vitest";

const jobId = "11111111-1111-4111-8111-111111111111";
const headRevision = "b".repeat(40);

function createContext(
  overrides: Partial<ReviewRunJobContext> = {},
): ReviewRunJobContext {
  return {
    jobId,
    provider: "github",
    targetRevision: headRevision,
    externalReviewRunId: null,
    repository: {
      externalId: "123456",
      owner: "doxahq",
      name: "doxa",
      installationExternalId: "789",
    },
    ...overrides,
  };
}

function createCommand(
  overrides: Partial<CreateReviewRunInput> = {},
): CreateReviewRunInput {
  return {
    status: "queued",
    title: "Documentation preview queued",
    summary: "Doxa is preparing the preview.",
    detailsUrl: null,
    sourceRevision: headRevision,
    ...overrides,
  };
}

describe("GitHub Checks adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("creates the named check with an exact repository-scoped token", async () => {
    const createInstallationToken = vi.fn(async () => "ghs_scoped");
    const fetchMock = vi.fn(async function (this: unknown) {
      expect(this).toBe(globalThis);
      return Response.json({ id: 9001 }, { status: 201 });
    });
    const adapter = new GitHubChecksAdapter({
      createInstallationToken,
      fetch: fetchMock,
    });
    const input = createCommand({
      status: "in_progress",
      detailsUrl: "https://preview.doxa.so",
    });

    await expect(adapter.create(createContext(), input)).resolves.toEqual({
      externalRunId: "9001",
    });

    expect(createInstallationToken).toHaveBeenCalledWith({
      installationId: "789",
      scope: {
        repositoryIds: [123456],
        permissions: {
          metadata: "read",
          contents: "read",
          pull_requests: "read",
          checks: "write",
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/doxahq/doxa/check-runs",
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer ghs_scoped",
          "content-type": "application/json",
          "user-agent": "doxa-platform",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          name: DOXA_DOCUMENTATION_PREVIEW_CHECK,
          head_sha: headRevision,
          external_id: jobId,
          status: "in_progress",
          details_url: "https://preview.doxa.so",
          output: {
            title: "Documentation preview queued",
            summary: "Doxa is preparing the preview.",
          },
        }),
      },
    );
  });

  test("finds an existing check by its generation job ID", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        check_runs: [
          { id: 8001, external_id: "another-job" },
          { id: 9001, external_id: jobId },
        ],
      }),
    );
    const adapter = new GitHubChecksAdapter({
      createInstallationToken: vi.fn(async () => "ghs_scoped"),
      fetch: fetchMock,
    });

    await expect(adapter.find(createContext())).resolves.toEqual({
      externalRunId: "9001",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/doxahq/doxa/commits/${headRevision}/check-runs?check_name=Doxa+documentation+preview&filter=all&per_page=100`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer ghs_scoped",
        }),
      }),
    );
  });

  test("updates the persisted check run with a terminal conclusion", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "9001" }));
    const adapter = new GitHubChecksAdapter({
      createInstallationToken: vi.fn(async () => "ghs_scoped"),
      fetch: fetchMock,
    });

    await expect(
      adapter.update(createContext({ externalReviewRunId: "9001" }), {
        externalRunId: "9001",
        status: "completed",
        conclusion: "success",
        title: "Documentation preview ready",
        summary: "The preview is ready.",
        detailsUrl: "https://preview.doxa.so",
        sourceRevision: headRevision,
      }),
    ).resolves.toEqual({ externalRunId: "9001" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/doxahq/doxa/check-runs/9001",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: DOXA_DOCUMENTATION_PREVIEW_CHECK,
          external_id: jobId,
          status: "completed",
          conclusion: "success",
          details_url: "https://preview.doxa.so",
          output: {
            title: "Documentation preview ready",
            summary: "The preview is ready.",
          },
        }),
      }),
    );
  });

  test("does not call GitHub when scoped token creation fails", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new GitHubChecksAdapter({
      createInstallationToken: vi.fn(async () => {
        throw new Error("token unavailable");
      }),
      fetch: fetchMock,
    });

    await expect(
      adapter.create(createContext(), createCommand()),
    ).rejects.toThrow("token unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces GitHub API and invalid response failures", async () => {
    const createInstallationToken = vi.fn(async () => "ghs_scoped");
    const failedAdapter = new GitHubChecksAdapter({
      createInstallationToken,
      fetch: vi.fn(async () => new Response(null, { status: 403 })),
    });
    const malformedAdapter = new GitHubChecksAdapter({
      createInstallationToken,
      fetch: vi.fn(async () => Response.json({ id: null }, { status: 201 })),
    });

    await expect(
      failedAdapter.create(createContext(), createCommand()),
    ).rejects.toThrow("GitHub check run create failed (403).");
    await expect(
      malformedAdapter.create(createContext(), createCommand()),
    ).rejects.toThrow(
      "GitHub check run create response did not include a valid ID.",
    );
  });
});

describe("provider-neutral review runs", () => {
  test("persists the external ID and turns a replay into an update", async () => {
    let externalReviewRunId: string | null = null;
    let claimToken: string | null = null;
    const claimedAt = new Date("2026-07-23T10:00:00.000Z");
    const jobs: ReviewRunJobsStore = {
      getReviewRunContext: vi.fn(async () =>
        createContext({ externalReviewRunId }),
      ),
      claimReviewRun: vi.fn(async (input): Promise<ReviewRunClaim> => {
        if (externalReviewRunId !== null) {
          return {
            outcome: "existing",
            externalRunId: externalReviewRunId,
          };
        }
        claimToken = input.claimToken;
        externalReviewRunId =
          `pending:${input.claimedAt.getTime()}:${input.claimToken}`;
        return { outcome: "claimed", reconcile: false };
      }),
      completeReviewRunClaim: vi.fn(async (input) => {
        if (claimToken !== input.claimToken) return false;
        externalReviewRunId = input.externalRunId;
        return true;
      }),
    };
    const find = vi.fn(async () => null);
    const create = vi.fn(async () => ({ externalRunId: "9001" }));
    const update = vi.fn(async () => ({ externalRunId: "9001" }));
    const github: ReviewRunProviderAdapter = { find, create, update };
    const service = new ReviewRunsService({
      jobs,
      adapters: { github },
      createClaimToken: () => "claim-1",
      now: () => claimedAt,
    });
    const input = createCommand({
      detailsUrl: "https://preview.doxa.so",
      metrics: {
        changedSourceCount: 4,
        regeneratedPageCount: 2,
        reusedPageCount: 8,
      },
    });

    await expect(service.create(jobId, input)).resolves.toEqual({
      externalRunId: "9001",
      outcome: "created",
    });
    await expect(service.create(jobId, input)).resolves.toEqual({
      externalRunId: "9001",
      outcome: "updated",
    });

    expect(jobs.completeReviewRunClaim).toHaveBeenCalledWith({
      jobId,
      claimToken: "claim-1",
      claimedAt,
      externalRunId: "9001",
    });
    expect(find).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(
      createContext({ externalReviewRunId: "9001" }),
      expect.objectContaining({
        externalRunId: "9001",
        summary: [
          "Doxa is preparing the preview.",
          "Preview: https://preview.doxa.so",
          "Changed sources: 4 · Regenerated pages: 2 · Reused pages: 8",
        ].join("\n\n"),
      }),
    );
  });

  test("retains the creation claim after an ambiguous provider failure", async () => {
    const claimedAt = new Date("2026-07-23T10:00:00.000Z");
    const jobs: ReviewRunJobsStore = {
      getReviewRunContext: vi.fn(async () => createContext()),
      claimReviewRun: vi.fn(
        async (): Promise<ReviewRunClaim> => ({
          outcome: "claimed",
          reconcile: false,
        }),
      ),
      completeReviewRunClaim: vi.fn(async () => true),
    };
    const github: ReviewRunProviderAdapter = {
      find: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error("GitHub unavailable");
      }),
      update: vi.fn(async () => ({ externalRunId: "9001" })),
    };
    const service = new ReviewRunsService({
      jobs,
      adapters: { github },
      createClaimToken: () => "claim-2",
      now: () => claimedAt,
    });

    await expect(
      service.create(jobId, createCommand()),
    ).rejects.toThrow("GitHub unavailable");
    expect(jobs.completeReviewRunClaim).not.toHaveBeenCalled();
  });

  test("reconciles a stale claim before creating another provider run", async () => {
    const claimedAt = new Date("2026-07-23T10:06:00.000Z");
    const jobs: ReviewRunJobsStore = {
      getReviewRunContext: vi.fn(async () =>
        createContext({ externalReviewRunId: "pending:old:claim" }),
      ),
      claimReviewRun: vi.fn(
        async (): Promise<ReviewRunClaim> => ({
          outcome: "claimed",
          reconcile: true,
        }),
      ),
      completeReviewRunClaim: vi.fn(async () => true),
    };
    const find = vi.fn(async () => ({ externalRunId: "9001" }));
    const create = vi.fn(async () => ({ externalRunId: "9002" }));
    const update = vi.fn(async () => ({ externalRunId: "9001" }));
    const service = new ReviewRunsService({
      jobs,
      adapters: { github: { find, create, update } },
      createClaimToken: () => "claim-4",
      now: () => claimedAt,
    });

    await expect(
      service.create(jobId, createCommand()),
    ).resolves.toEqual({
      externalRunId: "9001",
      outcome: "updated",
    });

    expect(find).toHaveBeenCalledWith(
      createContext({ externalReviewRunId: "pending:old:claim" }),
    );
    expect(jobs.completeReviewRunClaim).toHaveBeenCalledWith({
      jobId,
      claimToken: "claim-4",
      claimedAt,
      externalRunId: "9001",
    });
    expect(update).toHaveBeenCalledWith(
      createContext({ externalReviewRunId: "pending:old:claim" }),
      expect.objectContaining({ externalRunId: "9001" }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects an update for a check run that belongs to another job", async () => {
    const jobs: ReviewRunJobsStore = {
      getReviewRunContext: vi.fn(async () =>
        createContext({ externalReviewRunId: "9001" }),
      ),
      claimReviewRun: vi.fn(
        async (): Promise<ReviewRunClaim> => ({ outcome: "pending" }),
      ),
      completeReviewRunClaim: vi.fn(async () => false),
    };
    const update = vi.fn(async () => ({ externalRunId: "9001" }));
    const service = new ReviewRunsService({
      jobs,
      adapters: {
        github: {
          find: vi.fn(async () => null),
          create: vi.fn(async () => ({ externalRunId: "9001" })),
          update,
        },
      },
      createClaimToken: () => "claim-3",
      now: () => new Date("2026-07-23T10:00:00.000Z"),
    });

    await expect(
      service.update(jobId, {
        externalRunId: "9002",
        status: "completed",
        conclusion: "failure",
        title: "Documentation preview failed",
        summary: "Generation failed.",
        detailsUrl: null,
        sourceRevision: headRevision,
      }),
    ).rejects.toThrow("Review run ID does not belong to this generation job.");
    expect(update).not.toHaveBeenCalled();
  });

  test.each([
    ["queued", { status: "queued" }],
    ["in_progress", { status: "in_progress" }],
    ["success", { status: "completed", conclusion: "success" }],
    ["failure", { status: "completed", conclusion: "failure" }],
    ["cancelled", { status: "completed", conclusion: "cancelled" }],
    [
      "action_required",
      { status: "completed", conclusion: "action_required" },
    ],
  ] as const)("maps %s to provider-neutral status fields", (state, expected) => {
    expect(mapDoxabotReviewRunState(state)).toEqual(expected);
  });

  test("requires conclusions only for completed commands", () => {
    expect(
      createReviewRunInputSchema.safeParse({
        ...createCommand(),
        status: "completed",
      }).success,
    ).toBe(false);
    expect(
      updateReviewRunInputSchema.safeParse({
        ...createCommand(),
        externalRunId: "9001",
        status: "queued",
        conclusion: "success",
      }).success,
    ).toBe(false);
  });
});
