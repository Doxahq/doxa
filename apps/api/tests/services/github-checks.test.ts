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
  checkAgreesWithJob,
  failedJobEnd,
  failedPreviewEnding,
  mapDoxabotReviewRunState,
  RETRY_PREVIEW_ACTION,
  reviewRunPresentationFor,
  ReviewRunsService,
  timedOutPreviewEnding,
  type ReviewRunProviderAdapter,
} from "../../src/services/doxabot/review-runs";
import { afterEach, describe, expect, test, vi } from "vitest";

const jobId = "11111111-1111-4111-8111-111111111111";
const headRevision = "b".repeat(40);
const projectId = "22222222-2222-4222-8222-222222222222";
const links = {
  generation: (project: string, job: string) =>
    `https://doxa.test/dashboard/projects/${project}/generations/${job}`,
};
const generationUrl = links.generation(projectId, jobId);

function createContext(
  overrides: Partial<ReviewRunJobContext> = {},
): ReviewRunJobContext {
  return {
    jobId,
    projectId,
    status: "queued",
    errorMessage: null,
    provider: "github",
    targetRevision: headRevision,
    externalReviewRunId: null,
    cancelledPresentation: null,
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

  test("sends the check's buttons only when the command names them", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 9001 }));
    const adapter = new GitHubChecksAdapter({
      createInstallationToken: vi.fn(async () => "ghs_scoped"),
      fetch: fetchMock,
    });
    const failed = {
      externalRunId: "9001",
      status: "completed",
      conclusion: "failure",
      title: "Documentation preview failed",
      summary: "The model provider timed out.",
      detailsUrl: generationUrl,
      sourceRevision: headRevision,
    } as const;
    const context = createContext({ externalReviewRunId: "9001" });

    await adapter.update(context, { ...failed, actions: [RETRY_PREVIEW_ACTION] });
    await adapter.update(context, failed);

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies[0].actions).toEqual([
      { label: "Retry preview", description: "Run this documentation preview again", identifier: "retry_preview" },
    ]);
    expect(bodies[1]).not.toHaveProperty("actions");
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
      markReviewRunCompleted: vi.fn(async () => undefined),
    };
    const find = vi.fn(async () => null);
    const create = vi.fn(async () => ({ externalRunId: "9001" }));
    const update = vi.fn(async () => ({ externalRunId: "9001" }));
    const github: ReviewRunProviderAdapter = { find, create, update };
    const service = new ReviewRunsService({
      jobs,
      adapters: { github },
      links,
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
      markReviewRunCompleted: vi.fn(async () => undefined),
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
      links,
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
      markReviewRunCompleted: vi.fn(async () => undefined),
    };
    const find = vi.fn(async () => ({ externalRunId: "9001" }));
    const create = vi.fn(async () => ({ externalRunId: "9002" }));
    const update = vi.fn(async () => ({ externalRunId: "9001" }));
    const service = new ReviewRunsService({
      jobs,
      adapters: { github: { find, create, update } },
      links,
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
      markReviewRunCompleted: vi.fn(async () => undefined),
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
      links,
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

  describe("keeping the check in agreement with its job", () => {
    function serviceWith(contexts: ReviewRunJobContext[]) {
      const queue = [...contexts];
      const update = vi.fn(async () => ({ externalRunId: "9001" }));
      const create = vi.fn(async () => ({ externalRunId: "9001" }));
      const service = new ReviewRunsService({
        jobs: {
          // Each read returns the next context, then keeps the last one.
          getReviewRunContext: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]) ?? null),
          claimReviewRun: vi.fn(async (): Promise<ReviewRunClaim> => ({ outcome: "claimed", reconcile: false })),
          completeReviewRunClaim: vi.fn(async () => true),
          markReviewRunCompleted: vi.fn(async () => undefined),
        },
        adapters: { github: { find: vi.fn(async () => null), create, update } },
        links,
        createClaimToken: () => "claim-5",
        now: () => new Date("2026-07-23T10:00:00.000Z"),
      });
      return { service, update, create };
    }

    test("skips a progress update for a job that was cancelled", async () => {
      const { service, update } = serviceWith([createContext({ status: "cancelled", externalReviewRunId: "9001" })]);

      await expect(
        service.update(jobId, {
          externalRunId: "9001",
          status: "in_progress",
          title: "Generating documentation preview",
          summary: "Doxa is analyzing this pull request.",
          detailsUrl: null,
          sourceRevision: headRevision,
        }),
      ).resolves.toEqual({ externalRunId: "9001", outcome: "skipped" });
      expect(update).not.toHaveBeenCalled();
    });

    test("creates the check in the job's own end state when the job ended first", async () => {
      const { service, create } = serviceWith([createContext({ status: "cancelled" })]);

      await service.create(jobId, createCommand());

      expect(create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "completed", conclusion: "cancelled" }),
      );
    });

    test("reports a created check as created even when the correction fails", async () => {
      const { service, update } = serviceWith([
        createContext({ status: "queued" }),
        createContext({ status: "cancelled", externalReviewRunId: "9001" }),
      ]);
      update.mockRejectedValueOnce(new Error("GitHub unavailable"));

      await expect(service.create(jobId, createCommand())).resolves.toEqual({ externalRunId: "9001", outcome: "created" });
    });

    test("closes a check whose job was cancelled while GitHub created it", async () => {
      // The cancel found no run ID yet; the creator reads the job again after storing it.
      const { service, create, update } = serviceWith([
        createContext({ status: "queued" }),
        createContext({ status: "cancelled", externalReviewRunId: "9001" }),
      ]);

      await expect(service.create(jobId, createCommand())).resolves.toMatchObject({ outcome: "created" });

      expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "queued" }));
      expect(update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ externalRunId: "9001", status: "completed", conclusion: "cancelled" }),
      );
    });

    test("closes it with the text of the cancel, such as stopped for a closed pull request", async () => {
      const stopped = {
        title: "Documentation preview stopped",
        summary: "The pull request was closed, so Doxa stopped this preview.",
      };
      const { service, update } = serviceWith([
        createContext({ status: "queued" }),
        createContext({ status: "cancelled", externalReviewRunId: "9001", cancelledPresentation: stopped }),
      ]);

      await service.create(jobId, createCommand());

      expect(update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ conclusion: "cancelled", title: stopped.title, summary: stopped.summary }),
      );
    });

    test("creates the check with the text of a cancel that landed first", async () => {
      const superseded = {
        title: "Documentation preview superseded",
        summary: "A newer pull request revision is available, so this preview was cancelled.",
      };
      const { service, create } = serviceWith([
        createContext({ status: "cancelled", cancelledPresentation: superseded }),
      ]);

      await service.create(jobId, createCommand());

      expect(create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ conclusion: "cancelled", title: superseded.title, summary: superseded.summary }),
      );
    });

    test("uses the default text for a job that ended in another way", async () => {
      // A stored cancel text never relabels a failed job.
      const { service, create } = serviceWith([
        createContext({ status: "failed", cancelledPresentation: null }),
      ]);

      await service.create(jobId, createCommand());

      expect(create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ conclusion: "failure", title: "Documentation preview failed" }),
      );
    });
  });

  describe("cancelling the check of a preview job", () => {
    const presentation = { title: "Documentation preview stopped", summary: "The pull request was merged." };

    function serviceFor(context: ReviewRunJobContext | null) {
      const update = vi.fn(async () => ({ externalRunId: "9001" }));
      const service = new ReviewRunsService({
        jobs: {
          getReviewRunContext: vi.fn(async () => context),
          claimReviewRun: vi.fn(async (): Promise<ReviewRunClaim> => ({ outcome: "not_found" })),
          completeReviewRunClaim: vi.fn(async () => false),
          markReviewRunCompleted: vi.fn(async () => undefined),
        },
        adapters: { github: { find: vi.fn(async () => null), create: vi.fn(async () => ({ externalRunId: "9001" })), update } },
        links,
        createClaimToken: () => "claim-4",
        now: () => new Date("2026-07-23T10:00:00.000Z"),
      });
      return { service, update };
    }

    test("completes the job's check as cancelled on its target commit", async () => {
      const context = createContext({ externalReviewRunId: "9001" });
      const { service, update } = serviceFor(context);

      await expect(service.cancel(jobId, presentation)).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith(context, {
        externalRunId: "9001",
        status: "completed",
        conclusion: "cancelled",
        title: presentation.title,
        summary: presentation.summary,
        detailsUrl: null,
        sourceRevision: headRevision,
      });
    });

    test("finishes a check that AI credits stopped as neutral with the billing link (billing spec 10.6)", async () => {
      const context = createContext({ externalReviewRunId: "9001", status: "stopped_credits" });
      const { service, update } = serviceFor(context);

      await expect(
        service.finish(jobId, "neutral", { title: "AI credits ran out", summary: "Out of credits.", detailsUrl: "https://doxa.test/dashboard/billing/acct_1" }),
      ).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith(context, {
        externalRunId: "9001",
        status: "completed",
        conclusion: "neutral",
        title: "AI credits ran out",
        summary: "Out of credits.\n\nBilling: https://doxa.test/dashboard/billing/acct_1",
        detailsUrl: "https://doxa.test/dashboard/billing/acct_1",
        sourceRevision: headRevision,
      });
    });

    test("a stopped_credits job accepts only a neutral check", () => {
      expect(checkAgreesWithJob("stopped_credits", { status: "completed", conclusion: "neutral" })).toBe(true);
      expect(checkAgreesWithJob("stopped_credits", { status: "completed", conclusion: "failure" })).toBe(false);
      expect(reviewRunPresentationFor("stopped_credits")).toMatchObject({ conclusion: "neutral", title: "AI credits ran out" });
    });

    test.each([
      ["a production job", null],
      ["a preview whose check was never created", createContext()],
      ["a preview whose check is still being created", createContext({ externalReviewRunId: "pending:job:claim" })],
    ])("does nothing for %s", async (_name, context) => {
      const { service, update } = serviceFor(context);

      await expect(service.cancel(jobId, presentation)).resolves.toBe(false);
      expect(update).not.toHaveBeenCalled();
    });
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
    ["neutral", { status: "completed", conclusion: "neutral" }],
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

describe("ending the check of a preview job", () => {
  function serviceFor(context: ReviewRunJobContext | null) {
    const update = vi.fn(async () => ({ externalRunId: "9001" }));
    const create = vi.fn(async () => ({ externalRunId: "9001" }));
    const markReviewRunCompleted = vi.fn(async () => undefined);
    const now = new Date("2026-11-25T18:00:00.000Z");
    const service = new ReviewRunsService({
      jobs: {
        getReviewRunContext: vi.fn(async () => context),
        claimReviewRun: vi.fn(async (): Promise<ReviewRunClaim> => ({ outcome: "claimed", reconcile: false })),
        completeReviewRunClaim: vi.fn(async () => true),
        markReviewRunCompleted,
      },
      adapters: { github: { find: vi.fn(async () => null), create, update } },
      links,
      createClaimToken: () => "claim-6",
      now: () => now,
    });
    return { service, update, create, markReviewRunCompleted, now };
  }

  test("a failed run shows its reason, a link to the run and a retry button", async () => {
    const context = createContext({ externalReviewRunId: "9001", status: "failed" });
    const { service, update } = serviceFor(context);

    await expect(
      service.finish(jobId, "failure", failedPreviewEnding("The model provider timed out.")),
    ).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith(context, {
      externalRunId: "9001",
      status: "completed",
      conclusion: "failure",
      title: "Documentation preview failed",
      summary: `The model provider timed out.\n\nDetails: ${generationUrl}`,
      detailsUrl: generationUrl,
      sourceRevision: headRevision,
      actions: [RETRY_PREVIEW_ACTION],
    });
  });

  test("a failure without a reason uses the default text", () => {
    expect(failedPreviewEnding(null)).toEqual({
      title: "Documentation preview failed",
      summary: "Doxa could not generate a documentation preview for this pull request.",
      retryable: true,
    });
    expect(failedPreviewEnding("   ").summary).toBe(
      "Doxa could not generate a documentation preview for this pull request.",
    );
  });

  test("a failure that needs a person links to the run but offers no retry", async () => {
    const context = createContext({ externalReviewRunId: "9001", status: "failed" });
    const { service, update } = serviceFor(context);
    const end = failedJobEnd("Merge conflict.", {
      conclusion: "action_required",
      title: "Documentation preview needs a clean merge",
      summary: "Resolve the merge conflict.",
    });

    await service.finish(jobId, end.state, end.ending);

    expect(update).toHaveBeenCalledWith(context, {
      externalRunId: "9001",
      status: "completed",
      conclusion: "action_required",
      title: "Documentation preview needs a clean merge",
      summary: `Resolve the merge conflict.\n\nDetails: ${generationUrl}`,
      detailsUrl: generationUrl,
      sourceRevision: headRevision,
    });
  });

  test("a failure that the worker names as a plain failure keeps the retry", () => {
    expect(failedJobEnd("Boom.", { conclusion: "failure", title: "Failed", summary: "Boom." })).toEqual({
      state: "failure",
      ending: { title: "Failed", summary: "Boom.", retryable: true },
    });
    expect(failedJobEnd("Boom.")).toEqual({ state: "failure", ending: failedPreviewEnding("Boom.") });
  });

  test.each([
    ["queued", "Doxa did not start this preview in time."],
    ["running", "The preview ran longer than its time limit, so Doxa stopped it."],
  ] as const)("a run that the watchdog ended while %s reads as timed out", (status, reason) => {
    expect(timedOutPreviewEnding(status)).toEqual({
      title: "Documentation preview timed out",
      summary: `${reason} Retry it, or push a new commit to start a new preview.`,
      retryable: true,
    });
  });

  test("records a completed check, so the cron leaves it alone", async () => {
    const { service, markReviewRunCompleted, now } = serviceFor(
      createContext({ externalReviewRunId: "9001", status: "failed" }),
    );

    await service.finish(jobId, "failure", failedPreviewEnding("Boom."));

    expect(markReviewRunCompleted).toHaveBeenCalledWith({ jobId, externalRunId: "9001", completedAt: now });
  });

  test("does not record a check that is still open", async () => {
    const { service, markReviewRunCompleted } = serviceFor(createContext({ externalReviewRunId: "9001", status: "running" }));

    await service.update(jobId, {
      externalRunId: "9001",
      status: "in_progress",
      title: "Generating documentation preview",
      summary: "Doxa is analyzing this pull request.",
      detailsUrl: null,
      sourceRevision: headRevision,
    });

    expect(markReviewRunCompleted).not.toHaveBeenCalled();
  });

  test("does not record a completed check of an active job, which can open again", async () => {
    // A queue failure completes the check while the job waits; the run can still start.
    const { service, markReviewRunCompleted } = serviceFor(createContext({ externalReviewRunId: "9001", status: "queued" }));

    await service.update(jobId, {
      externalRunId: "9001",
      status: "completed",
      conclusion: "action_required",
      title: "Documentation preview could not start",
      summary: "Doxa could not queue preview generation. A retry is required.",
      detailsUrl: null,
      sourceRevision: headRevision,
    });

    expect(markReviewRunCompleted).not.toHaveBeenCalled();
  });

  test("records a check that was created already completed", async () => {
    const { service, markReviewRunCompleted, now } = serviceFor(createContext({ status: "failed" }));

    await service.create(jobId, createCommand());

    expect(markReviewRunCompleted).toHaveBeenCalledWith({ jobId, externalRunId: "9001", completedAt: now });
  });

  test("a failed record never fails the close: the cron closes the check once more", async () => {
    const { service, markReviewRunCompleted } = serviceFor(createContext({ externalReviewRunId: "9001", status: "failed" }));
    markReviewRunCompleted.mockRejectedValueOnce(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(service.finish(jobId, "failure", failedPreviewEnding("Boom."))).resolves.toBe(true);
  });

  test("creates the check of a run that already failed with its reason and a retry", async () => {
    const { service, create } = serviceFor(createContext({ status: "failed", errorMessage: "Clone failed." }));

    await service.create(jobId, createCommand());

    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conclusion: "failure",
        summary: `Clone failed.\n\nDetails: ${generationUrl}`,
        detailsUrl: generationUrl,
        actions: [RETRY_PREVIEW_ACTION],
      }),
    );
  });

  describe("closing the open check of an ended job", () => {
    test("a failed job: its reason, the link and the retry", async () => {
      const context = createContext({ externalReviewRunId: "9001", status: "failed", errorMessage: "Clone failed." });
      const { service, update } = serviceFor(context);

      await expect(service.closeForEndedJob(jobId)).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith(
        context,
        expect.objectContaining({
          conclusion: "failure",
          summary: `Clone failed.\n\nDetails: ${generationUrl}`,
          actions: [RETRY_PREVIEW_ACTION],
        }),
      );
    });

    test("a cancelled job: the text that its cancel stored, with its retry", async () => {
      const timedOut = timedOutPreviewEnding("queued");
      const context = createContext({ externalReviewRunId: "9001", status: "cancelled", cancelledPresentation: timedOut });
      const { service, update } = serviceFor(context);

      await service.closeForEndedJob(jobId);

      expect(update).toHaveBeenCalledWith(context, {
        externalRunId: "9001",
        status: "completed",
        conclusion: "cancelled",
        title: timedOut.title,
        summary: `${timedOut.summary}\n\nDetails: ${generationUrl}`,
        detailsUrl: generationUrl,
        sourceRevision: headRevision,
        actions: [RETRY_PREVIEW_ACTION],
      });
    });

    test("a cancel without stored text uses the default cancel, with no retry", async () => {
      const context = createContext({ externalReviewRunId: "9001", status: "cancelled" });
      const { service, update } = serviceFor(context);

      await service.closeForEndedJob(jobId);

      expect(update).toHaveBeenCalledWith(context, {
        externalRunId: "9001",
        ...reviewRunPresentationFor("cancelled"),
        detailsUrl: null,
        sourceRevision: headRevision,
      });
    });

    test.each([
      ["succeeded", "success"],
      ["stopped_credits", "neutral"],
    ] as const)("a %s job closes as %s", async (status, conclusion) => {
      const context = createContext({ externalReviewRunId: "9001", status });
      const { service, update } = serviceFor(context);

      await service.closeForEndedJob(jobId);

      expect(update).toHaveBeenCalledWith(context, expect.objectContaining({ status: "completed", conclusion }));
    });

    test.each([
      ["a queued job", createContext({ externalReviewRunId: "9001", status: "queued" })],
      ["a running job", createContext({ externalReviewRunId: "9001", status: "running" })],
      ["a job without a check", createContext({ status: "failed" })],
      ["a check that is still being created", createContext({ status: "failed", externalReviewRunId: "pending:1:claim" })],
      ["a job that is not a preview", null],
    ])("does nothing for %s", async (_name, context) => {
      const { service, update } = serviceFor(context);

      await expect(service.closeForEndedJob(jobId)).resolves.toBe(false);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
