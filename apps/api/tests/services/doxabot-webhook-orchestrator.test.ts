import type { GenerationJobDto } from "@doxahq/contracts";
import type {
  ChangeProposalRecord,
  ChangeProposalsStore,
  EnsuredChangeProposal,
  EnsureChangeProposalInput,
} from "../../src/repositories/change-proposals";
import type {
  DoxabotAutomationContext,
  DoxabotSettingsStore,
} from "../../src/repositories/doxabot-settings";
import type {
  DoxabotGenerationJobAdmission,
  DoxabotGenerationJobsStore,
  DoxabotJobAdmissionInput,
} from "../../src/repositories/jobs";
import { previewAdmissionStop } from "../../src/repositories/preview-admission-guard";
import type {
  ClaimWebhookDeliveryInput,
  WebhookDeliveriesStore,
} from "../../src/repositories/webhook-deliveries";
import {
  DoxabotWebhookOrchestrator,
  PREVIEW_QUIET_WINDOW_SECONDS,
  billingStopCheck,
  resolveDoxabotExecutionConfig,
  type DoxabotWebhookDependencies,
  type PreviewRunBilling,
  type ProcessGitHubWebhookInput,
} from "../../src/services/doxabot/webhook-orchestrator";
import { CreditsExhaustedError, PlanLimitError } from "@doxahq/billing";
import type { ChangeProposalSnapshot } from "../../src/services/doxabot/change-proposal-state";
import type { GenerationCancellationInput } from "../../src/services/generation-cancellation";
import { describe, expect, test, vi } from "vitest";
import type { ProductAnalytics } from "@doxahq/analytics";
import { recordingProductAnalytics } from "../support/recording-product-analytics";

const projectId = "11111111-1111-4111-8111-111111111111";
const baselineVersionId = "22222222-2222-4222-8222-222222222222";
const previewVersionId = "33333333-3333-4333-8333-333333333333";
const baseSha = "a".repeat(40);
const firstHeadSha = "b".repeat(40);
const secondHeadSha = "c".repeat(40);
const firstUpdatedAt = "2026-07-23T10:00:00.000Z";
const closedAt = "2026-07-23T12:00:00.000Z";
const supersededCheck = {
  title: "Documentation preview superseded",
  summary: "A newer pull request revision is available, so this preview was cancelled.",
};

function createAutomationContext(
  overrides: Partial<DoxabotAutomationContext> = {},
): DoxabotAutomationContext {
  return {
    projectId,
    ownerUserId: "owner-user",
    repositoryExternalId: "123456",
    installationExternalId: "789",
    repositoryOwner: "doxahq",
    repositoryName: "doxa",
    repositoryVisibility: "private",
    productionBranch: "main",
    storedEnabled: true,
    mergeTrigger: "batched",
    allowedBotLogins: [],
    connectionIssue: null,
    hasPublishedVersion: true,
    publishedBaseline: { versionId: baselineVersionId, sourceRevision: baseSha },
    ...overrides,
  };
}

function pullRequestDelivery(input: {
  deliveryId: string;
  action?: string;
  headRevision?: string;
  baseRef?: string;
  draft?: boolean;
  merged?: boolean;
  isPrivate?: boolean;
  installationId?: number;
  sourceUpdatedAt?: string;
  /** For an "edited" action: the base that the pull request moved from. */
  baseChangedFrom?: string;
  /** The repository of the head branch; another ID is a fork, null a deleted fork. */
  headRepositoryId?: number | null;
  authorLogin?: string;
  authorType?: string;
  /** `repository.size` in KB; absent leaves the field out. */
  repositorySizeKb?: number;
}): ProcessGitHubWebhookInput {
  return {
    deliveryId: input.deliveryId,
    eventName: "pull_request",
    rawBody: JSON.stringify({
      action: input.action ?? "opened",
      ...(input.baseChangedFrom ? { changes: { base: { ref: { from: input.baseChangedFrom } } } } : {}),
      number: 42,
      installation: { id: input.installationId ?? 789 },
      repository: {
        id: 123456,
        private: input.isPrivate ?? true,
        default_branch: "main",
        ...(input.repositorySizeKb !== undefined ? { size: input.repositorySizeKb } : {}),
      },
      pull_request: {
        id: 987654,
        user: {
          id: 1,
          login: input.authorLogin ?? "octocat",
          avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
          type: input.authorType ?? "User",
        },
        updated_at: input.sourceUpdatedAt ?? firstUpdatedAt,
        draft: input.draft ?? false,
        merged: input.merged ?? false,
        base: {
          ref: input.baseRef ?? "main",
          sha: baseSha,
        },
        head: {
          sha: input.headRevision ?? firstHeadSha,
          ...(input.headRepositoryId !== undefined
            ? { repo: input.headRepositoryId === null ? null : { id: input.headRepositoryId } }
            : {}),
        },
      },
    }),
  };
}

function createHarness(
  context: DoxabotAutomationContext | null = createAutomationContext(),
  previewBaseline: {
    versionId: string;
    sourceRevision: string;
  } | null = null,
  previewBilling?: PreviewRunBilling,
  options: {
    publicRepositoriesEnabled?: boolean;
    maxRepositorySizeKb?: number;
    analytics?: ProductAnalytics;
    previewRetries?: DoxabotWebhookDependencies["previewRetries"];
  } = {},
) {
  const claimedDeliveries = new Set<string>();
  const normalizedEvents = new Map<
    string,
    ClaimWebhookDeliveryInput["normalizedEvent"]
  >();
  let proposal: ChangeProposalRecord | null = null;
  let nextJobNumber = 1;
  const jobsByIdempotency = new Map<string, GenerationJobDto>();
  const activeJobs = new Map<string, GenerationJobDto>();
  const publishedJobs = new Set<string>();

  const deliveries: WebhookDeliveriesStore = {
    claimDelivery: vi.fn(
      async (input: ClaimWebhookDeliveryInput) => {
        const key = `${input.provider}:${input.deliveryId}`;
        if (claimedDeliveries.has(key)) return "duplicate";
        claimedDeliveries.add(key);
        normalizedEvents.set(key, input.normalizedEvent);
        return "claimed";
      },
    ),
    getNormalizedEvent: vi.fn(async (input) =>
      normalizedEvents.get(`${input.provider}:${input.deliveryId}`) ?? null),
    markProcessed: vi.fn(async () => {}),
    markIgnored: vi.fn(async () => {}),
    markEnqueueFailed: vi.fn(async () => {}),
    markGenerationJobPublished: vi.fn(async (jobId) => {
      publishedJobs.add(jobId);
      return true;
    }),
    markFailed: vi.fn(async () => {}),
  };

  const settings: Pick<DoxabotSettingsStore, "getAutomationContext"> = {
    getAutomationContext: vi.fn(async () => context),
  };

  const changeProposals: ChangeProposalsStore = {
    ensure: vi.fn(
      async (
        input: EnsureChangeProposalInput,
      ): Promise<EnsuredChangeProposal> => {
        if (proposal) {
          return { outcome: "existing", proposal };
        }

        proposal = {
          id: "proposal-1",
          projectId: input.projectId,
          provider: input.provider,
          repositoryExternalId: input.repositoryExternalId,
          installationExternalId: input.installationExternalId,
          externalId: input.externalId,
          displayNumber: input.displayNumber,
          draft: input.draft,
          state: input.state,
          defaultBranch: input.defaultBranch,
          baseRef: input.baseRef,
          baseRevision: input.baseRevision,
          headRevision: input.headRevision,
          sourceUpdatedAt: input.sourceUpdatedAt,
          lastSourceTreeHash: null,
        };
        return { outcome: "created", proposal };
      },
    ),
    getByIdentity: vi.fn(async () => proposal),
    compareAndSetHead: vi.fn(async (input) => {
      if (!proposal || proposal.id !== input.proposalId) return null;
      if (proposal.headRevision !== input.expectedHeadRevision) return null;
      if (
        proposal.sourceUpdatedAt.getTime() !==
        input.expectedSourceUpdatedAt.getTime()
      ) {
        return null;
      }

      proposal = {
        ...proposal,
        headRevision: input.headRevision,
        baseRevision: input.baseRevision,
        defaultBranch: input.defaultBranch,
        baseRef: input.baseRef,
        installationExternalId: input.installationExternalId,
        draft: input.draft,
        state: input.state,
        sourceUpdatedAt: input.sourceUpdatedAt,
        lastSourceTreeHash:
          input.headRevision === input.expectedHeadRevision
            ? proposal.lastSourceTreeHash
            : null,
      };
      return proposal;
    }),
    recordSourceTreeHash: vi.fn(async () => true),
  };

  // The admission of the repository, over this harness's record: the guard,
  // then a replay, then the cancel of the active run that a new head replaces.
  const jobs: DoxabotGenerationJobsStore = {
    admitDoxabotJob: vi.fn(async (input: DoxabotJobAdmissionInput): Promise<DoxabotGenerationJobAdmission> => {
      if (!proposal) throw new Error("The pull request was not recorded.");
      const stop = previewAdmissionStop(proposal, input.guard, input.targetRevision);
      if (stop) return { outcome: "stale_change", reason: stop };

      const replayed = jobsByIdempotency.get(input.idempotencyKey);
      if (replayed) {
        return {
          outcome: "replayed",
          job: replayed,
          queuePublished: publishedJobs.has(replayed.id),
          supersededJobId: null,
        };
      }
      const active = activeJobs.get(input.concurrencyKey) ?? null;
      if (active) {
        const { message, eventType, data, check } = input.supersede;
        await jobs.markCancelled(active.id, message, eventType, data, check);
      }

      const job = createJob(`job-${nextJobNumber}`);
      nextJobNumber += 1;
      jobsByIdempotency.set(input.idempotencyKey, job);
      activeJobs.set(input.concurrencyKey, job);
      return {
        outcome: "created",
        job,
        queuePublished: false,
        supersededJobId: active?.id ?? null,
      };
    }),
    activeForConcurrencyKey: vi.fn(
      async (concurrencyKey: string) =>
        activeJobs.get(concurrencyKey) ?? null,
    ),
    markCancelled: vi.fn(async (jobId: string) => {
      for (const [key, job] of activeJobs) {
        if (job.id === jobId) activeJobs.delete(key);
      }
      return true;
    }),
    addEvent: vi.fn(async (jobId, type, message, data, source) => ({
      id: "event-1",
      jobId,
      sequence: 1,
      source: source ?? "api",
      type,
      message,
      data: data ?? null,
      createdAt: "2026-07-23T10:00:00.000Z",
    })),
  };
  const previewBaselines = {
    findSuccessfulCompatiblePreview: vi.fn(
      async () => previewBaseline,
    ),
  };

  const queue = {
    send: vi.fn(async () => {}),
  };
  const reviewRuns = {
    create: vi.fn(async () => ({
      externalRunId: "9001",
      outcome: "created" as const,
    })),
    update: vi.fn(async () => ({
      externalRunId: "9001",
      outcome: "updated" as const,
    })),
  };
  const changeProposalState = {
    getCurrent: vi.fn(
      async (): Promise<ChangeProposalSnapshot> => {
        if (!proposal) {
          throw new Error("No current proposal state.");
        }
        return {
          externalId: proposal.externalId,
          number: proposal.displayNumber,
          draft: proposal.draft,
          state: proposal.state,
          baseRef: proposal.baseRef,
          baseRevision: proposal.baseRevision,
          headRevision: proposal.headRevision,
          sourceUpdatedAt: proposal.sourceUpdatedAt,
        };
      },
    ),
  };
  const mergeTriggers = { recordMerge: vi.fn(async () => undefined) };
  // The real canceller closes the check too; the job side is what the
  // concurrency bookkeeping of this harness needs.
  const previewJobs = {
    cancel: vi.fn(async (input: GenerationCancellationInput) =>
      jobs.markCancelled(input.jobId, input.message, input.eventType, input.data, input.check),
    ),
    finishCancel: vi.fn(async (_input: GenerationCancellationInput) => undefined),
  };
  const previewChannels = { closeForChange: vi.fn(async () => 1) };
  const lifecycle = {
    setInstallationStatus: vi.fn(async () => 1),
    disconnectRepository: vi.fn(async () => true),
    reconnectRepository: vi.fn(async () => true),
    canAddRepository: vi.fn(async () => true),
    addRepository: vi.fn(async () => true),
    updateRepository: vi.fn(async (): Promise<{
      previousVisibility: "private" | "public";
      projectIds: string[];
    } | null> => ({ previousVisibility: "private", projectIds: [projectId] })),
    pauseAutomation: vi.fn(async () => undefined),
    recordInstaller: vi.fn(async () => true),
  };
  const repositoryDefaultBranch = vi.fn(async (_input: {
    repositoryExternalId: string;
    installationExternalId: string;
  }): Promise<string | null> => "trunk");
  const dependencies = {
    deliveries,
    settings,
    changeProposals,
    jobs,
    previewBaselines,
    queue,
    reviewRuns,
    changeProposalState,
    deploymentPolicy: {
      enabled: true,
      publicRepositoriesEnabled: options.publicRepositoriesEnabled ?? false,
    },
    executionConfig: {
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
      generationProfile: "full-prod",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generatorFingerprint: "generator-v1",
    },
    mergeTriggers,
    previewJobs,
    previewChannels,
    ...(previewBilling ? { previewBilling } : {}),
    lifecycle,
    repositoryDefaultBranch,
    ...(options.maxRepositorySizeKb !== undefined ? { maxRepositorySizeKb: options.maxRepositorySizeKb } : {}),
    ...(options.analytics ? { analytics: options.analytics } : {}),
    ...(options.previewRetries ? { previewRetries: options.previewRetries } : {}),
    now: () => new Date(closedAt),
  } satisfies DoxabotWebhookDependencies;

  return {
    orchestrator: new DoxabotWebhookOrchestrator(dependencies),
    mergeTriggers,
    previewJobs,
    previewChannels,
    lifecycle,
    repositoryDefaultBranch,
    deliveries,
    settings,
    changeProposals,
    jobs,
    previewBaselines,
    queue,
    reviewRuns,
    changeProposalState,
    getProposal: () => proposal,
    setJobState(
      jobId: string,
      state: Pick<GenerationJobDto, "status" | "errorMessage">,
    ) {
      for (const job of jobsByIdempotency.values()) {
        if (job.id === jobId) Object.assign(job, state);
      }
    },
  };
}

function createJob(id: string): GenerationJobDto {
  return {
    id,
    projectId,
    status: "queued",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
  };
}

describe("Doxabot webhook orchestrator", () => {
  test("defaults new generation jobs to Sonnet 5.5 planning and Haiku 5.5 writing", () => {
    expect(resolveDoxabotExecutionConfig({})).toEqual({
      plannerModel: "claude-sonnet-5-5",
      writerModel: "claude-haiku-5-5",
      generationProfile: "fast-mvp",
      planningFingerprint:
        "doxabot-planning-v10:fast-mvp",
      writingFingerprint:
        "doxabot-writing-v2:claude-haiku-5-5:writer-handoff-v1",
      generatorFingerprint:
        "doxabot-v2:doxabot-planning-v10:fast-mvp:doxabot-writing-v2:claude-haiku-5-5:writer-handoff-v1",
    });
  });

  test("resolves one immutable execution configuration at admission", () => {
    expect(
      resolveDoxabotExecutionConfig({
        DOXA_AGENT_MODEL: " x-ai/grok-4.5 ",
        DOXA_GENERATION_PROFILE: "full-prod",
      }),
    ).toEqual({
      plannerModel: "x-ai/grok-4.5",
      writerModel: "x-ai/grok-4.5",
      generationProfile: "full-prod",
      planningFingerprint:
        "doxabot-planning-v10:full-prod",
      writingFingerprint:
        "doxabot-writing-v2:x-ai/grok-4.5:writer-handoff-v1",
      generatorFingerprint:
        "doxabot-v2:doxabot-planning-v10:full-prod:doxabot-writing-v2:x-ai/grok-4.5:writer-handoff-v1",
    });
  });

  test("claims and hashes malformed raw payloads before recording failure", async () => {
    const harness = createHarness();
    const rawBody = "{not-json";

    await expect(
      harness.orchestrator.process({
        deliveryId: "malformed-delivery",
        eventName: "pull_request",
        rawBody,
      }),
    ).resolves.toEqual({
      outcome: "malformed",
      reason: "invalid_payload",
    });

    expect(harness.deliveries.claimDelivery).toHaveBeenCalledWith({
      provider: "github",
      deliveryId: "malformed-delivery",
      eventName: "pull_request",
      action: null,
      repositoryExternalId: null,
      payloadHash: await sha256(rawBody),
      normalizedEvent: {
        outcome: "malformed",
        reason: "invalid_payload",
      },
    });
    expect(harness.deliveries.markFailed).toHaveBeenCalledWith({
      provider: "github",
      deliveryId: "malformed-delivery",
      errorCode: "invalid_payload",
    });
    expect(harness.settings.getAutomationContext).not.toHaveBeenCalled();
    expect(harness.queue.send).not.toHaveBeenCalled();
    expect(harness.reviewRuns.create).not.toHaveBeenCalled();
  });

  test("returns duplicate deliveries before any downstream work", async () => {
    const harness = createHarness();
    const delivery = pullRequestDelivery({ deliveryId: "delivery-1" });

    const [first, duplicate] = await Promise.all([
      harness.orchestrator.process(delivery),
      harness.orchestrator.process(delivery),
    ]);

    expect([first.outcome, duplicate.outcome].sort()).toEqual([
      "duplicate",
      "enqueued",
    ]);
    expect(harness.queue.send).toHaveBeenCalledOnce();
    expect(harness.reviewRuns.create).toHaveBeenCalledOnce();
    expect(harness.changeProposals.ensure).toHaveBeenCalledOnce();
    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledOnce();
    expect(harness.settings.getAutomationContext).toHaveBeenCalledWith({
      provider: "github",
      repositoryExternalId: "123456",
      installationExternalId: "789",
    });
  });

  test("does not resolve an event from an unmatched installation", async () => {
    const harness = createHarness(null);

    await expect(
      harness.orchestrator.process(
        pullRequestDelivery({
          deliveryId: "delivery-stale-installation",
          installationId: 999,
        }),
      ),
    ).resolves.toEqual({
      outcome: "ignored",
      reason: "project_not_found",
    });

    expect(harness.settings.getAutomationContext).toHaveBeenCalledWith({
      provider: "github",
      repositoryExternalId: "123456",
      installationExternalId: "999",
    });
    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
    expect(harness.queue.send).not.toHaveBeenCalled();
  });

  test("rejects public repositories before creating downstream records", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-2",
      isPrivate: false,
    }))).resolves.toEqual({
      outcome: "ignored",
      reason: "public_repository_disabled",
    });

    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
    expect(harness.queue.send).not.toHaveBeenCalled();
    expect(harness.reviewRuns.create).not.toHaveBeenCalled();
    expect(harness.deliveries.markIgnored).toHaveBeenCalledWith({
      provider: "github",
      deliveryId: "delivery-2",
      reason: "public_repository_disabled",
    });
  });

  test("ignores disabled projects without creating proposal state", async () => {
    const harness = createHarness(
      createAutomationContext({ storedEnabled: false }),
    );

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-3",
    }))).resolves.toEqual({
      outcome: "ignored",
      reason: "project_disabled",
    });
    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
    expect(harness.queue.send).not.toHaveBeenCalled();
  });

  test("ignores pull requests against a non-default base", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-4",
      baseRef: "release",
    }))).resolves.toEqual({
      outcome: "ignored",
      reason: "non_production_base",
    });
    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
    expect(harness.queue.send).not.toHaveBeenCalled();
  });

  test("previews pull requests that target the project's production branch", async () => {
    // GitHub's default branch stays `main`; the project chose `release`.
    const harness = createHarness(createAutomationContext({ productionBranch: "release" }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-production-branch",
      baseRef: "release",
    }))).resolves.toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(harness.changeProposals.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: "release", baseRef: "release" }),
    );
  });

  test("ignores pull requests against GitHub's default branch when the production branch differs", async () => {
    const harness = createHarness(createAutomationContext({ productionBranch: "release" }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-default-branch",
      baseRef: "main",
    }))).resolves.toEqual({
      outcome: "ignored",
      reason: "non_production_base",
    });
    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
  });

  test("feeds a merge into the production branch to the merge trigger", async () => {
    const harness = createHarness(createAutomationContext({ productionBranch: "release" }));

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-production-merge",
      action: "closed",
      merged: true,
      baseRef: "release",
    }));

    expect(harness.mergeTriggers.recordMerge).toHaveBeenCalledOnce();
  });

  test("reports a new preview run as a cold Doxabot generation for the project owner", async () => {
    const recording = recordingProductAnalytics();
    const harness = createHarness(createAutomationContext({ publishedBaseline: null }), null, undefined, { analytics: recording.analytics });

    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-analytics" }));

    expect(await recording.events()).toEqual([
      {
        kind: "event",
        event: "generation_started",
        distinctId: "owner-user",
        properties: { trigger: "doxabot", run: "cold" },
        groups: { project: expect.any(String) },
      },
    ]);
  });

  test("keeps previews on after the generation cache was cleared, and starts them without a baseline", async () => {
    // The site still serves its version; only the version stopped being a baseline.
    const harness = createHarness(createAutomationContext({ publishedBaseline: null }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-cleared-cache",
    }))).resolves.toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledWith(
      expect.objectContaining({ baselineVersionId: null, baselineRevision: null }),
    );
  });

  test("still waits for the first publish before any preview", async () => {
    const harness = createHarness(createAutomationContext({ hasPublishedVersion: false, publishedBaseline: null }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-unpublished",
    }))).resolves.toEqual({ outcome: "ignored", reason: "initial_generation_required" });
    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
  });

  test.each([
    { merged: false, state: "closed", reason: "change_closed" },
    { merged: true, state: "merged", reason: "change_merged" },
  ])("a $state pull request stops its preview and takes its preview site offline", async ({ merged, state, reason }) => {
    const harness = createHarness();
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: `delivery-open-${state}` }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: `delivery-${state}`,
      action: "closed",
      merged,
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }))).resolves.toEqual({ outcome: "ignored", reason });

    expect(harness.previewJobs.cancel).toHaveBeenCalledWith({
      jobId: "job-1",
      message: `The pull request was ${state}.`,
      eventType: "doxabot_change_ended",
      data: { reason: state },
      check: {
        title: "Documentation preview stopped",
        summary: `The pull request was ${state}, so Doxa stopped this preview.`,
      },
    });
    expect(harness.previewChannels.closeForChange).toHaveBeenCalledWith({
      projectId,
      provider: "github",
      changeExternalId: "987654",
      closedAt: new Date(closedAt),
    });
  });

  test("closes the preview site of an ended pull request with no preview running", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-closed-idle",
      action: "closed",
    }));

    expect(harness.previewJobs.cancel).not.toHaveBeenCalled();
    expect(harness.previewChannels.closeForChange).toHaveBeenCalledOnce();
  });

  test("an older closed event does not take a reopened pull request offline", async () => {
    const harness = createHarness();
    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-reopened",
      action: "reopened",
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-late-close",
      action: "closed",
      sourceUpdatedAt: firstUpdatedAt,
    }))).resolves.toMatchObject({ outcome: "ignored" });

    expect(harness.previewChannels.closeForChange).not.toHaveBeenCalled();
    expect(harness.previewJobs.cancel).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "Doxabot was turned off",
      change: (context: DoxabotAutomationContext) => {
        context.storedEnabled = false;
      },
      reason: "project_disabled",
    },
    {
      name: "the production branch moved",
      change: (context: DoxabotAutomationContext) => {
        context.productionBranch = "release";
      },
      reason: "non_production_base",
    },
  ])("an ended pull request still stops its recorded preview when $name", async ({ change, reason }) => {
    const context = createAutomationContext();
    const harness = createHarness(context);
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-recorded" }));
    change(context);

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-ended-ignored",
      action: "closed",
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }))).resolves.toEqual({ outcome: "ignored", reason });

    expect(harness.previewJobs.cancel).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      check: expect.objectContaining({ title: "Documentation preview stopped" }),
    }));
    expect(harness.previewChannels.closeForChange).toHaveBeenCalledOnce();
    expect(harness.getProposal()).toMatchObject({ state: "closed" });
  });

  test("a pull request that moves off the production branch stops its preview", async () => {
    const harness = createHarness();
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-on-main" }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-retargeted",
      action: "synchronize",
      baseRef: "release",
      headRevision: secondHeadSha,
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }))).resolves.toEqual({ outcome: "ignored", reason: "non_production_base" });

    expect(harness.previewJobs.cancel).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      data: { reason: "retargeted" },
      check: {
        title: "Documentation preview stopped",
        summary: "The pull request no longer targets the production branch, so Doxa stopped this preview.",
      },
    }));
    expect(harness.previewChannels.closeForChange).toHaveBeenCalledOnce();
    // The record follows the pull request, so a re-run sees the new base.
    expect(harness.getProposal()).toMatchObject({ baseRef: "release" });
  });

  test("a base change off the production branch stops the preview at once, without a push", async () => {
    const harness = createHarness();
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-before-base-change" }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-base-changed",
      action: "edited",
      baseRef: "release",
      baseChangedFrom: "main",
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }))).resolves.toEqual({ outcome: "ignored", reason: "non_production_base" });

    expect(harness.previewJobs.cancel).toHaveBeenCalledWith(expect.objectContaining({ data: { reason: "retargeted" } }));
    expect(harness.previewChannels.closeForChange).toHaveBeenCalledOnce();
  });

  test("refuses the preview of a repository above the size limit before admission", async () => {
    const harness = createHarness(createAutomationContext(), null, undefined, { maxRepositorySizeKb: 1000 });

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-too-large",
      repositorySizeKb: 1001,
    }))).resolves.toEqual({ outcome: "ignored", reason: "repository_too_large" });

    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
    expect(harness.queue.send).not.toHaveBeenCalled();
    expect(harness.previewJobs.cancel).not.toHaveBeenCalled();
    expect(harness.deliveries.markIgnored).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-too-large", reason: "repository_too_large" }),
    );
  });

  test("a push that makes the repository too large stops the run on the old head with a check", async () => {
    const harness = createHarness(createAutomationContext(), null, undefined, { maxRepositorySizeKb: 1000 });
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-small", repositorySizeKb: 900 }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-grown",
      action: "synchronize",
      headRevision: secondHeadSha,
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
      repositorySizeKb: 1500,
    }))).resolves.toEqual({ outcome: "ignored", reason: "repository_too_large" });

    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledOnce();
    expect(harness.previewJobs.cancel).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      eventType: "doxabot_preview_refused",
      data: { reason: "repository_too_large", sizeKb: 1500, limitKb: 1000 },
      check: expect.objectContaining({ title: "Documentation preview stopped" }),
    }));
    expect(harness.previewChannels.closeForChange).not.toHaveBeenCalled();
  });

  test("previews a repository at the size limit, or one whose size GitHub did not send", async () => {
    const harness = createHarness(createAutomationContext(), null, undefined, { maxRepositorySizeKb: 1000 });

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-at-limit",
      repositorySizeKb: 1000,
    }))).resolves.toEqual({ outcome: "enqueued", jobId: "job-1" });
    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-no-size",
      action: "synchronize",
      headRevision: secondHeadSha,
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }))).resolves.toMatchObject({ outcome: "enqueued" });
  });

  test("a merge of a large repository still feeds the merge trigger", async () => {
    const harness = createHarness(createAutomationContext(), null, undefined, { maxRepositorySizeKb: 1000 });

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-large-merge",
      action: "closed",
      merged: true,
      repositorySizeKb: 5000,
    }));

    expect(harness.mergeTriggers.recordMerge).toHaveBeenCalledOnce();
  });

  test("a push while Doxabot is off cancels the run on the old head but keeps the last preview online", async () => {
    const context = createAutomationContext();
    const harness = createHarness(context);
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-before-disable" }));
    context.storedEnabled = false;

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-push-disabled",
      action: "synchronize",
      headRevision: secondHeadSha,
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }))).resolves.toEqual({ outcome: "ignored", reason: "project_disabled" });

    expect(harness.previewJobs.cancel).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      eventType: "doxabot_superseded",
      check: expect.objectContaining({ title: "Documentation preview superseded" }),
    }));
    expect(harness.previewChannels.closeForChange).not.toHaveBeenCalled();
    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledOnce();
  });

  test("a pull request that Doxa never recorded has no preview to stop", async () => {
    const harness = createHarness(createAutomationContext({ storedEnabled: false }));

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-unrecorded-close",
      action: "closed",
    }));

    expect(harness.previewChannels.closeForChange).not.toHaveBeenCalled();
    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
  });

  test("a late closed event does not stop a reopened pull request while Doxabot is off", async () => {
    const context = createAutomationContext();
    const harness = createHarness(context);
    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-reopened-recorded",
      action: "reopened",
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }));
    context.storedEnabled = false;

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-late-close-disabled",
      action: "closed",
      sourceUpdatedAt: firstUpdatedAt,
    }));

    expect(harness.previewChannels.closeForChange).not.toHaveBeenCalled();
    expect(harness.previewJobs.cancel).not.toHaveBeenCalled();
  });

  test("the preview site goes offline even when the job cancel fails", async () => {
    const harness = createHarness();
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-open-cancel-fails" }));
    harness.previewJobs.cancel.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-close-cancel-fails",
      action: "closed",
      sourceUpdatedAt: "2026-07-23T10:05:00.000Z",
    }))).rejects.toThrow("database unavailable");

    expect(harness.previewChannels.closeForChange).toHaveBeenCalledOnce();
  });

  test("a failed merge record does not keep the preview online", async () => {
    const harness = createHarness();
    harness.mergeTriggers.recordMerge.mockRejectedValueOnce(new Error("merge store unavailable"));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-merge-record-fails",
      action: "closed",
      merged: true,
    }))).rejects.toThrow("merge store unavailable");

    expect(harness.previewChannels.closeForChange).toHaveBeenCalledOnce();
  });

  test("an open pull request on another base leaves preview sites alone", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-open-other-base",
      baseRef: "release",
    }));

    expect(harness.previewChannels.closeForChange).not.toHaveBeenCalled();
  });

  test("records drafts and enqueues when the same head becomes ready", async () => {
    const harness = createHarness();

    const draft = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-5",
      draft: true,
    }));
    const ready = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-6",
      action: "ready_for_review",
      draft: false,
      sourceUpdatedAt: "2026-07-23T10:01:00.000Z",
    }));

    expect(draft).toEqual({ outcome: "ignored", reason: "draft_change" });
    expect(ready).toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(harness.changeProposals.ensure).toHaveBeenCalledTimes(2);
    expect(harness.queue.send).toHaveBeenCalledOnce();
    expect(harness.reviewRuns.create).toHaveBeenCalledOnce();
    expect(harness.getProposal()).toMatchObject({
      draft: false,
      headRevision: firstHeadSha,
    });
  });

  test("uses the preceding compatible preview from the same pull request", async () => {
    const harness = createHarness(createAutomationContext(), {
      versionId: previewVersionId,
      sourceRevision: firstHeadSha,
    });

    await expect(
      harness.orchestrator.process(
        pullRequestDelivery({
          deliveryId: "delivery-preview-baseline",
          action: "synchronize",
          headRevision: secondHeadSha,
          sourceUpdatedAt: "2026-07-23T10:01:00.000Z",
        }),
      ),
    ).resolves.toEqual({
      outcome: "enqueued",
      jobId: "job-1",
    });

    expect(
      harness.previewBaselines.findSuccessfulCompatiblePreview,
    ).toHaveBeenCalledWith({
      projectId,
      provider: "github",
      changeExternalId: "987654",
    });
    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineVersionId: previewVersionId,
        baselineRevision: firstHeadSha,
      }),
    );
  });

  test("falls back to the published default-branch baseline", async () => {
    const harness = createHarness();

    await expect(
      harness.orchestrator.process(
        pullRequestDelivery({
          deliveryId: "delivery-default-branch-baseline",
        }),
      ),
    ).resolves.toEqual({
      outcome: "enqueued",
      jobId: "job-1",
    });

    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledWith(
      expect.objectContaining({
        plannerModel: "x-ai/grok-4.5:nitro",
        writerModel: "moonshotai/kimi-k2.6:nitro",
        generationProfile: "full-prod",
        generatorFingerprint: "generator-v1",
        baselineVersionId,
        baselineRevision: baseSha,
        sourceAuthor: {
          externalId: "1",
          handle: "octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        },
      }),
    );
  });

  test("replays the same accepted head without publishing another queue message", async () => {
    const harness = createHarness();

    const first = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-7",
    }));
    const replayed = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-8",
      action: "synchronize",
    }));

    expect(first).toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(replayed).toEqual({ outcome: "replayed", jobId: "job-1" });
    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledTimes(2);
    expect(harness.queue.send).toHaveBeenCalledOnce();
    expect(harness.reviewRuns.create).toHaveBeenCalledTimes(2);
  });

  test("reconciles a replayed failed head as failed without publishing another queue message", async () => {
    const harness = createHarness();

    const first = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-failed-replay-1",
    }));
    harness.setJobState("job-1", {
      status: "failed",
      errorMessage: "Generation failed.",
    });
    const replayed = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-failed-replay-2",
      action: "synchronize",
    }));

    expect(first).toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(replayed).toEqual({ outcome: "replayed", jobId: "job-1" });
    expect(harness.queue.send).toHaveBeenCalledOnce();
    expect(harness.reviewRuns.create).toHaveBeenLastCalledWith("job-1", {
      status: "completed",
      conclusion: "failure",
      title: "Documentation preview failed",
      summary:
        "Doxa could not generate a documentation preview for this pull request.",
      detailsUrl: null,
      sourceRevision: firstHeadSha,
    });
  });

  test("feeds a merged pull request to the merge trigger", async () => {
    const harness = createHarness();

    const merged = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-merged",
      action: "closed",
      merged: true,
    }));

    expect(merged).toEqual({ outcome: "ignored", reason: "change_merged" });
    expect(harness.mergeTriggers.recordMerge).toHaveBeenCalledWith({
      projectId,
      mergeTrigger: "batched",
      changeExternalId: "987654",
      changeNumber: 42,
      mergedAt: new Date(firstUpdatedAt),
    });
    expect(harness.queue.send).not.toHaveBeenCalled();
  });

  test("feeds a merge to the merge trigger also while pull request previews are off", async () => {
    // Previews and merge updates are separate settings.
    const harness = createHarness(createAutomationContext({ storedEnabled: false }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-merged-previews-off",
      action: "closed",
      merged: true,
    }))).resolves.toEqual({ outcome: "ignored", reason: "project_disabled" });

    expect(harness.mergeTriggers.recordMerge).toHaveBeenCalledWith({
      projectId,
      mergeTrigger: "batched",
      changeExternalId: "987654",
      changeNumber: 42,
      mergedAt: new Date(firstUpdatedAt),
    });
    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "Doxabot is not available for the project",
      context: { hasPublishedVersion: false, publishedBaseline: null },
    },
    {
      name: "the pull request merged into another branch",
      context: { storedEnabled: false, productionBranch: "release" },
    },
  ])("does not feed a merge to the merge trigger when $name", async ({ context }) => {
    const harness = createHarness(createAutomationContext(context));

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-merged-not-fed",
      action: "closed",
      merged: true,
    }));

    expect(harness.mergeTriggers.recordMerge).not.toHaveBeenCalled();
  });

  test("does not feed a closed, unmerged pull request to the merge trigger", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-closed",
      action: "closed",
    }));

    expect(harness.mergeTriggers.recordMerge).not.toHaveBeenCalled();
  });

  test("does not reopen a closed proposal when an older action arrives later", async () => {
    const harness = createHarness();

    const closed = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-9",
      action: "closed",
    }));
    const reordered = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-10",
      action: "synchronize",
    }));

    expect(closed).toEqual({ outcome: "ignored", reason: "change_closed" });
    expect(reordered).toEqual({
      outcome: "ignored",
      reason: "stale_change_event",
    });
    expect(harness.getProposal()).toMatchObject({ state: "closed" });
    expect(harness.queue.send).not.toHaveBeenCalled();
  });

  test("does not roll a proposal back when an older head arrives later", async () => {
    const harness = createHarness();

    const newer = await harness.orchestrator.process(
      pullRequestDelivery({
        deliveryId: "delivery-newer-head",
        headRevision: secondHeadSha,
        sourceUpdatedAt: "2026-07-23T10:02:00.000Z",
      }),
    );
    const older = await harness.orchestrator.process(
      pullRequestDelivery({
        deliveryId: "delivery-older-head",
        action: "synchronize",
        headRevision: firstHeadSha,
        sourceUpdatedAt: "2026-07-23T10:01:00.000Z",
      }),
    );

    expect(newer).toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(older).toEqual({
      outcome: "ignored",
      reason: "stale_change_event",
    });
    expect(harness.getProposal()).toMatchObject({
      headRevision: secondHeadSha,
    });
    expect(harness.queue.send).toHaveBeenCalledOnce();
  });

  test("uses current GitHub state to resolve equal-timestamp head changes", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(
      pullRequestDelivery({ deliveryId: "delivery-equal-first" }),
    );
    harness.changeProposalState.getCurrent.mockResolvedValueOnce({
      externalId: "987654",
      number: 42,
      draft: false,
      state: "open",
      baseRef: "main",
      baseRevision: baseSha,
      headRevision: secondHeadSha,
      sourceUpdatedAt: new Date(firstUpdatedAt),
    });

    await expect(
      harness.orchestrator.process(
        pullRequestDelivery({
          deliveryId: "delivery-equal-second",
          action: "synchronize",
          headRevision: secondHeadSha,
        }),
      ),
    ).resolves.toEqual({ outcome: "enqueued", jobId: "job-2" });

    expect(harness.changeProposalState.getCurrent).toHaveBeenCalledOnce();
    expect(harness.getProposal()).toMatchObject({
      headRevision: secondHeadSha,
    });
  });

  test("supersedes an active preview when a new head arrives", async () => {
    const harness = createHarness();

    const first = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-11",
    }));
    const second = await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-12",
      action: "synchronize",
      headRevision: secondHeadSha,
      sourceUpdatedAt: "2026-07-23T10:01:00.000Z",
    }));

    expect(first).toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(second).toEqual({ outcome: "enqueued", jobId: "job-2" });
    // The admission cancels the old run, with the check text of the cancel.
    expect(harness.jobs.markCancelled).toHaveBeenCalledWith(
      "job-1",
      "Superseded by a newer pull request head.",
      "doxabot_superseded",
      { targetRevision: secondHeadSha },
      supersededCheck,
    );
    expect(harness.queue.send).toHaveBeenCalledTimes(2);
    // The old commit's check closes with the job, not when a worker gets to it.
    expect(harness.previewJobs.finishCancel).toHaveBeenCalledWith({
      jobId: "job-1",
      message: "Superseded by a newer pull request head.",
      eventType: "doxabot_superseded",
      data: { targetRevision: secondHeadSha },
      check: supersededCheck,
    });
    expect(harness.previewJobs.cancel).not.toHaveBeenCalled();
  });

  test("a close that lands before the admission of a push refuses its preview", async () => {
    const harness = createHarness();
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-race-open" }));
    // The push writes its record, then the close runs before its admission.
    const admit = vi.mocked(harness.jobs.admitDoxabotJob).getMockImplementation();
    vi.mocked(harness.jobs.admitDoxabotJob).mockImplementationOnce(async (input) => {
      await harness.orchestrator.process(pullRequestDelivery({
        deliveryId: "delivery-race-close",
        action: "closed",
        headRevision: secondHeadSha,
        sourceUpdatedAt: "2026-07-23T10:01:30.000Z",
      }));
      if (!admit) throw new Error("The harness has no admission.");
      return admit(input);
    });

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-race-push",
      action: "synchronize",
      headRevision: secondHeadSha,
      sourceUpdatedAt: "2026-07-23T10:01:00.000Z",
    }))).resolves.toEqual({ outcome: "ignored", reason: "stale_change_event" });

    // The close stopped the run of the old head; no run of the new head exists.
    expect(harness.previewJobs.cancel).toHaveBeenCalledOnce();
    expect(harness.previewJobs.cancel).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      check: expect.objectContaining({ title: "Documentation preview stopped" }),
    }));
    expect(harness.previewChannels.closeForChange).toHaveBeenCalledOnce();
    expect(harness.queue.send).toHaveBeenCalledOnce();
    expect(harness.reviewRuns.create).toHaveBeenCalledOnce();
  });

  test("an older push that is admitted late does not cancel the run of a newer push", async () => {
    const harness = createHarness();
    const thirdHeadSha = "d".repeat(40);
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-order-open" }));
    const admit = vi.mocked(harness.jobs.admitDoxabotJob).getMockImplementation();
    vi.mocked(harness.jobs.admitDoxabotJob).mockImplementationOnce(async (input) => {
      await harness.orchestrator.process(pullRequestDelivery({
        deliveryId: "delivery-order-newer",
        action: "synchronize",
        headRevision: thirdHeadSha,
        sourceUpdatedAt: "2026-07-23T10:02:00.000Z",
      }));
      if (!admit) throw new Error("The harness has no admission.");
      return admit(input);
    });

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-order-older",
      action: "synchronize",
      headRevision: secondHeadSha,
      sourceUpdatedAt: "2026-07-23T10:01:00.000Z",
    }))).resolves.toEqual({ outcome: "ignored", reason: "stale_change_event" });

    // Only job-1 was replaced, by job-2 of the newest head, which still runs.
    expect(harness.previewJobs.finishCancel).toHaveBeenCalledOnce();
    expect(harness.previewJobs.finishCancel).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1" }));
    expect(harness.jobs.markCancelled).not.toHaveBeenCalledWith("job-2", expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(harness.queue.send).toHaveBeenCalledTimes(2);
    expect(harness.queue.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ jobId: "job-2" }),
      { delaySeconds: PREVIEW_QUIET_WINDOW_SECONDS },
    );
    expect(harness.getProposal()).toMatchObject({ headRevision: thirdHeadSha });
  });

  test("a preview that cannot reserve credits ends neutral with a billing link and is not queued", async () => {
    const refusal = new CreditsExhaustedError({ accountId: "acct_1", available: 10, needed: 220, reason: "max_debt", resetsAt: null });
    const billing: PreviewRunBilling = {
      admit: vi.fn(async () => refusal),
      stop: vi.fn(async () => "https://doxa.test/dashboard/billing/acct_1"),
    };
    const harness = createHarness(createAutomationContext(), null, billing);

    await expect(
      harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-no-credits" })),
    ).resolves.toEqual({ outcome: "billing_refused", jobId: "job-1" });

    expect(billing.admit).toHaveBeenCalledWith({ jobId: "job-1", projectId, baselineVersionId });
    expect(billing.stop).toHaveBeenCalledWith({ jobId: "job-1", projectId, refusal });
    expect(harness.reviewRuns.create).toHaveBeenCalledWith("job-1", expect.objectContaining({
      status: "completed",
      conclusion: "neutral",
      title: "AI credits ran out",
      detailsUrl: "https://doxa.test/dashboard/billing/acct_1",
    }));
    expect(harness.queue.send).not.toHaveBeenCalled();
    expect(harness.deliveries.markProcessed).toHaveBeenCalled();
  });

  test("a preview with credits is queued as before", async () => {
    const billing: PreviewRunBilling = { admit: vi.fn(async () => null), stop: vi.fn(async () => null) };
    const harness = createHarness(createAutomationContext(), null, billing);
    await expect(
      harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-with-credits" })),
    ).resolves.toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(billing.stop).not.toHaveBeenCalled();
    expect(harness.queue.send).toHaveBeenCalledOnce();
  });

  test("a preview without a baseline is admitted cold, so billing meters it as a full generation", async () => {
    const billing: PreviewRunBilling = { admit: vi.fn(async () => null), stop: vi.fn(async () => null) };
    const harness = createHarness(createAutomationContext({ publishedBaseline: null }), null, billing);
    await expect(
      harness.orchestrator.process(pullRequestDelivery({ deliveryId: "delivery-cold" })),
    ).resolves.toEqual({ outcome: "enqueued", jobId: "job-1" });
    expect(billing.admit).toHaveBeenCalledWith({ jobId: "job-1", projectId, baselineVersionId: null });
  });

  test("a cold preview refused for ai.doxa_agent says the plan has no full generations", () => {
    expect(billingStopCheck(new PlanLimitError({ key: "ai.doxa_agent", limit: false, used: null }))).toMatchObject({
      title: "Full generation is not in the plan",
    });
    expect(billingStopCheck(new PlanLimitError({ key: "ai.doxabot", limit: false, used: null }))).toMatchObject({
      title: "Doxabot is not in the plan",
    });
  });

  test("keeps generation recoverable when GitHub check creation fails", async () => {
    const harness = createHarness();
    harness.reviewRuns.create.mockRejectedValueOnce(
      new Error("GitHub unavailable"),
    );

    await expect(
      harness.orchestrator.process(
        pullRequestDelivery({ deliveryId: "delivery-check-failure" }),
      ),
    ).resolves.toEqual({
      outcome: "enqueued",
      jobId: "job-1",
    });

    expect(harness.jobs.addEvent).toHaveBeenCalledWith(
      "job-1",
      "review_run_create_failed",
      "Doxabot could not create the external review run.",
      { error: "GitHub unavailable" },
      "system",
    );
    expect(harness.queue.send).toHaveBeenCalledOnce();
    expect(harness.deliveries.markProcessed).toHaveBeenCalled();
  });

  test("leaves a recoverable delivery outcome when queue publication fails", async () => {
    const harness = createHarness();
    harness.queue.send.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "delivery-13",
    }))).resolves.toEqual({
      outcome: "enqueue_failed",
      jobId: "job-1",
    });
    expect(harness.deliveries.markEnqueueFailed).toHaveBeenCalledWith({
      provider: "github",
      deliveryId: "delivery-13",
      errorCode: "queue_publication_failed",
    });
    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-13",
        sourceInstallationExternalId: "789",
      }),
    );
    expect(harness.deliveries.markProcessed).not.toHaveBeenCalled();
    expect(harness.reviewRuns.update).toHaveBeenCalledWith("job-1", {
      externalRunId: "9001",
      status: "completed",
      conclusion: "action_required",
      title: "Documentation preview could not start",
      summary:
        "Doxa could not queue preview generation. A retry is required.",
      detailsUrl: null,
      sourceRevision: firstHeadSha,
    });
  });

  test("recovers an unpublished job when the same head is delivered again", async () => {
    const harness = createHarness();
    harness.queue.send.mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    const failed = await harness.orchestrator.process(
      pullRequestDelivery({
        deliveryId: "delivery-recovery-1",
      }),
    );
    const recovered = await harness.orchestrator.process(
      pullRequestDelivery({
        deliveryId: "delivery-recovery-2",
        action: "synchronize",
      }),
    );

    expect(failed).toEqual({
      outcome: "enqueue_failed",
      jobId: "job-1",
    });
    expect(recovered).toEqual({
      outcome: "replayed",
      jobId: "job-1",
    });
    expect(harness.queue.send).toHaveBeenCalledTimes(2);
    expect(
      harness.deliveries.markGenerationJobPublished,
    ).toHaveBeenCalledWith("job-1");
  });
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("Doxabot pull request trust (Decision 3) and bots", () => {
  test.each(["OWNER", "MEMBER", "COLLABORATOR", "NONE"])(
    "ignores a fork pull request by a %s author and posts nothing",
    async (association) => {
      const harness = createHarness();
      const delivery = pullRequestDelivery({ deliveryId: `fork-${association}`, headRepositoryId: 654321 });
      const body = JSON.parse(delivery.rawBody);
      body.pull_request.author_association = association;

      await expect(harness.orchestrator.process({ ...delivery, rawBody: JSON.stringify(body) }))
        .resolves.toEqual({ outcome: "ignored", reason: "fork_pull_request" });

      expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
      expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
      expect(harness.reviewRuns.create).not.toHaveBeenCalled();
      expect(harness.queue.send).not.toHaveBeenCalled();
      expect(harness.mergeTriggers.recordMerge).not.toHaveBeenCalled();
    },
  );

  test("ignores a pull request from a deleted fork", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "deleted-fork",
      headRepositoryId: null,
    }))).resolves.toEqual({ outcome: "ignored", reason: "fork_pull_request" });
    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
  });

  test("feeds a merged fork pull request to the merge trigger, never to a preview", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "fork-merged",
      action: "closed",
      merged: true,
      headRepositoryId: 654321,
    }))).resolves.toEqual({ outcome: "ignored", reason: "fork_pull_request" });

    expect(harness.mergeTriggers.recordMerge).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      changeExternalId: "987654",
    }));
    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
    expect(harness.reviewRuns.create).not.toHaveBeenCalled();
  });

  test("a fork pull request event stops a preview made before the fork rule", async () => {
    const harness = createHarness();
    // A preview from before the rule, when trusted forks got one.
    await harness.orchestrator.process(pullRequestDelivery({ deliveryId: "old-preview" }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "fork-push",
      action: "synchronize",
      headRevision: secondHeadSha,
      headRepositoryId: 654321,
      sourceUpdatedAt: closedAt,
    }))).resolves.toEqual({ outcome: "ignored", reason: "fork_pull_request" });

    expect(harness.previewJobs.cancel).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      eventType: "doxabot_change_skipped",
    }));
    expect(harness.previewChannels.closeForChange).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      changeExternalId: "987654",
    }));
    expect(harness.jobs.admitDoxabotJob).toHaveBeenCalledOnce();
  });

  test("skips a pull request by a bot by default", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "dependabot",
      authorLogin: "dependabot[bot]",
      authorType: "Bot",
    }))).resolves.toEqual({ outcome: "ignored", reason: "bot_author" });
    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
    expect(harness.reviewRuns.create).not.toHaveBeenCalled();
  });

  test("previews a pull request by a bot that the project allows by login", async () => {
    const harness = createHarness(createAutomationContext({ allowedBotLogins: ["Dependabot"] }));

    await expect(harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "allowed-bot",
      authorLogin: "dependabot[bot]",
      authorType: "Bot",
    }))).resolves.toEqual({ outcome: "enqueued", jobId: "job-1" });
  });

  test("a merged bot pull request still feeds the merge trigger", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(pullRequestDelivery({
      deliveryId: "bot-merged",
      action: "closed",
      merged: true,
      authorLogin: "renovate[bot]",
      authorType: "Bot",
    }));
    expect(harness.mergeTriggers.recordMerge).toHaveBeenCalledOnce();
  });

  test("previews a public repository when the rollout flag is on", async () => {
    const harness = createHarness(createAutomationContext(), null, undefined, { publicRepositoriesEnabled: true });

    await expect(harness.orchestrator.process(pullRequestDelivery({ deliveryId: "public", isPrivate: false })))
      .resolves.toEqual({ outcome: "enqueued", jobId: "job-1" });
  });
});

describe("Doxabot preview quiet window", () => {
  test("holds each preview for the quiet window, so quick pushes start one run", async () => {
    const harness = createHarness();
    const heads = [firstHeadSha, secondHeadSha, "d".repeat(40)];

    for (const [index, head] of heads.entries()) {
      await harness.orchestrator.process(pullRequestDelivery({
        deliveryId: `push-${index}`,
        action: index === 0 ? "opened" : "synchronize",
        headRevision: head,
        sourceUpdatedAt: new Date(Date.parse(firstUpdatedAt) + index * 10_000).toISOString(),
      }));
    }

    // Every message waits the quiet window in the queue.
    expect(harness.queue.send).toHaveBeenCalledTimes(3);
    for (const call of harness.queue.send.mock.calls as unknown as unknown[][]) {
      expect(call[1]).toEqual({ delaySeconds: PREVIEW_QUIET_WINDOW_SECONDS });
    }
    // Each newer push cancelled the queued run before its message came out,
    // so only the run of the last head starts.
    expect(harness.jobs.markCancelled).toHaveBeenCalledWith("job-1", expect.anything(), "doxabot_superseded", expect.anything(), expect.anything());
    expect(harness.jobs.markCancelled).toHaveBeenCalledWith("job-2", expect.anything(), "doxabot_superseded", expect.anything(), expect.anything());
    expect(harness.jobs.markCancelled).not.toHaveBeenCalledWith("job-3", expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(PREVIEW_QUIET_WINDOW_SECONDS).toBe(120);
  });
});

describe("Doxabot repository lifecycle events", () => {
  function lifecycleDelivery(eventName: string, deliveryId: string, body: Record<string, unknown>): ProcessGitHubWebhookInput {
    return { deliveryId, eventName, rawBody: JSON.stringify(body) };
  }
  const repositoryBody = (overrides: Record<string, unknown> = {}) => ({
    id: 123456,
    name: "doxa",
    full_name: "doxahq/doxa",
    owner: { login: "doxahq" },
    private: true,
    default_branch: "main",
    ...overrides,
  });

  test.each([
    ["suspend", "suspended"],
    ["unsuspend", "active"],
    ["deleted", "deleted"],
  ] as const)("installation %s sets the installation %s", async (action, status) => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(lifecycleDelivery("installation", `install-${action}`, {
      action,
      installation: { id: 789 },
    }))).resolves.toEqual({ outcome: "applied", changed: 1 });

    expect(harness.lifecycle.setInstallationStatus).toHaveBeenCalledWith({
      installationExternalId: "789",
      status,
      at: new Date(closedAt),
    });
    expect(harness.deliveries.markProcessed).toHaveBeenCalledWith({ provider: "github", deliveryId: `install-${action}` });
  });

  test("a new installation without a sender changes no record here", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(lifecycleDelivery("installation", "install-created", {
      action: "created",
      installation: { id: 789 },
    }))).resolves.toEqual({ outcome: "applied", changed: 0 });
    expect(harness.lifecycle.setInstallationStatus).not.toHaveBeenCalled();
    expect(harness.lifecycle.recordInstaller).not.toHaveBeenCalled();
  });

  test("a new installation records who installed it (Decision 6)", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(lifecycleDelivery("installation", "install-created-sender", {
      action: "created",
      installation: { id: 789 },
      sender: { id: 5150, login: "octo-admin" },
    }))).resolves.toEqual({ outcome: "applied", changed: 1 });
    expect(harness.lifecycle.recordInstaller).toHaveBeenCalledWith({
      installationExternalId: "789",
      installer: { githubUserId: "5150", login: "octo-admin" },
    });
    expect(harness.lifecycle.setInstallationStatus).not.toHaveBeenCalled();
  });

  test("a suspend keeps no sender as installer", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(lifecycleDelivery("installation", "install-suspend-sender", {
      action: "suspend",
      installation: { id: 789 },
      sender: { id: 6000, login: "someone-else" },
    }));
    expect(harness.lifecycle.recordInstaller).not.toHaveBeenCalled();
  });

  test("a repository removed from the app is disconnected, and an added one reconnected", async () => {
    const harness = createHarness();
    const short = { id: 123456, name: "doxa", full_name: "doxahq/doxa", private: false };

    await harness.orchestrator.process(lifecycleDelivery("installation_repositories", "repos-removed", {
      action: "removed",
      installation: { id: 789 },
      repositories_added: [],
      repositories_removed: [short],
    }));
    await harness.orchestrator.process(lifecycleDelivery("installation_repositories", "repos-added", {
      action: "added",
      installation: { id: 789 },
      repositories_added: [short],
      repositories_removed: [],
    }));

    expect(harness.lifecycle.disconnectRepository).toHaveBeenCalledWith({
      repositoryExternalId: "123456",
      installationExternalId: "789",
      reason: "removed",
      at: new Date(closedAt),
    });
    expect(harness.lifecycle.reconnectRepository).toHaveBeenCalledWith({
      repositoryExternalId: "123456",
      installationExternalId: "789",
      visibility: "public",
    });
  });

  test("a new repository of an installation on all repositories gets a row (repository.created)", async () => {
    const harness = createHarness();
    harness.lifecycle.reconnectRepository.mockResolvedValueOnce(false);

    await expect(harness.orchestrator.process(lifecycleDelivery("repository", "repo-created", {
      action: "created",
      installation: { id: 789 },
      repository: repositoryBody({ id: 222, name: "react-email", full_name: "ipenywis/react-email", owner: { login: "ipenywis" }, private: false }),
    }))).resolves.toEqual({ outcome: "applied", changed: 1 });

    expect(harness.lifecycle.addRepository).toHaveBeenCalledWith({
      repositoryExternalId: "222",
      installationExternalId: "789",
      fullName: "ipenywis/react-email",
      owner: "ipenywis",
      name: "react-email",
      defaultBranch: "main",
      visibility: "public",
    });
    // The event has the branch, so GitHub is not asked.
    expect(harness.repositoryDefaultBranch).not.toHaveBeenCalled();
    expect(harness.deliveries.markProcessed).toHaveBeenCalledWith({ provider: "github", deliveryId: "repo-created" });
  });

  test("a repository added to the selection gets a row, with its default branch read from GitHub", async () => {
    const harness = createHarness();
    harness.lifecycle.reconnectRepository.mockResolvedValueOnce(false);

    await expect(harness.orchestrator.process(lifecycleDelivery("installation_repositories", "repos-added-new", {
      action: "added",
      installation: { id: 789 },
      repositories_added: [{ id: 333, name: "docs", full_name: "acme/docs", private: true }],
      repositories_removed: [],
    }))).resolves.toEqual({ outcome: "applied", changed: 1 });

    expect(harness.repositoryDefaultBranch).toHaveBeenCalledWith({
      repositoryExternalId: "333",
      installationExternalId: "789",
    });
    expect(harness.lifecycle.addRepository).toHaveBeenCalledWith({
      repositoryExternalId: "333",
      installationExternalId: "789",
      fullName: "acme/docs",
      owner: "acme",
      name: "docs",
      defaultBranch: "trunk",
      visibility: "private",
    });
  });

  test("a repository that was connected before is reconnected, with no new row and no GitHub read", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(lifecycleDelivery("installation_repositories", "repos-added-known", {
      action: "added",
      installation: { id: 789 },
      repositories_added: [{ id: 123456, name: "doxa", full_name: "doxahq/doxa", private: false }],
      repositories_removed: [],
    }));

    expect(harness.lifecycle.reconnectRepository).toHaveBeenCalled();
    expect(harness.lifecycle.canAddRepository).not.toHaveBeenCalled();
    expect(harness.repositoryDefaultBranch).not.toHaveBeenCalled();
    expect(harness.lifecycle.addRepository).not.toHaveBeenCalled();
  });

  test("an unknown installation, or a repository that has a row, costs no GitHub read and adds nothing", async () => {
    const harness = createHarness();
    harness.lifecycle.reconnectRepository.mockResolvedValue(false);
    harness.lifecycle.canAddRepository.mockResolvedValue(false);

    await expect(harness.orchestrator.process(lifecycleDelivery("installation_repositories", "repos-added-unknown", {
      action: "added",
      installation: { id: 999 },
      repositories_added: [{ id: 444, name: "x", full_name: "someone/x", private: false }],
      repositories_removed: [],
    }))).resolves.toEqual({ outcome: "applied", changed: 0 });

    expect(harness.repositoryDefaultBranch).not.toHaveBeenCalled();
    expect(harness.lifecycle.addRepository).not.toHaveBeenCalled();
  });

  test("a failed default branch read adds no row and still finishes the delivery", async () => {
    const harness = createHarness();
    harness.lifecycle.reconnectRepository.mockResolvedValueOnce(false);
    harness.repositoryDefaultBranch.mockRejectedValueOnce(new Error("GitHub repository request failed (502)."));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(harness.orchestrator.process(lifecycleDelivery("installation_repositories", "repos-added-fail", {
      action: "added",
      installation: { id: 789 },
      repositories_added: [{ id: 555, name: "y", full_name: "acme/y", private: false }],
      repositories_removed: [],
    }))).resolves.toEqual({ outcome: "applied", changed: 0 });

    expect(harness.lifecycle.addRepository).not.toHaveBeenCalled();
    expect(harness.deliveries.markProcessed).toHaveBeenCalledWith({ provider: "github", deliveryId: "repos-added-fail" });
    warn.mockRestore();
  });

  test("a deleted repository is disconnected and its site stays", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(lifecycleDelivery("repository", "repo-deleted", {
      action: "deleted",
      installation: { id: 789 },
      repository: repositoryBody(),
    }));

    expect(harness.lifecycle.disconnectRepository).toHaveBeenCalledWith(expect.objectContaining({ reason: "deleted" }));
    expect(harness.previewChannels.closeForChange).not.toHaveBeenCalled();
  });

  test.each(["renamed", "transferred"])("a %s repository gets its new name and owner by its GitHub ID", async (action) => {
    const harness = createHarness();

    await harness.orchestrator.process(lifecycleDelivery("repository", `repo-${action}`, {
      action,
      installation: { id: 789 },
      repository: repositoryBody({ name: "docs", full_name: "acme/docs", owner: { login: "acme" } }),
    }));

    expect(harness.lifecycle.updateRepository).toHaveBeenCalledWith({
      repositoryExternalId: "123456",
      visibility: "private",
      fullName: "acme/docs",
      owner: "acme",
      name: "docs",
      defaultBranch: "main",
    });
    expect(harness.lifecycle.pauseAutomation).not.toHaveBeenCalled();
  });

  test("a public repository that becomes private pauses Doxabot for its projects", async () => {
    const harness = createHarness();
    harness.lifecycle.updateRepository.mockResolvedValueOnce({ previousVisibility: "public", projectIds: [projectId] });

    await harness.orchestrator.process(lifecycleDelivery("repository", "repo-privatized", {
      action: "privatized",
      installation: { id: 789 },
      repository: repositoryBody({ private: true }),
    }));

    expect(harness.lifecycle.updateRepository).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private" }));
    expect(harness.lifecycle.pauseAutomation).toHaveBeenCalledWith({
      projectIds: [projectId],
      reason: "repository_privatized",
      at: new Date(closedAt),
    });
  });

  test("a repository that becomes public updates its visibility and keeps Doxabot as it is", async () => {
    const harness = createHarness();

    await harness.orchestrator.process(lifecycleDelivery("repository", "repo-publicized", {
      action: "publicized",
      installation: { id: 789 },
      repository: repositoryBody({ private: false }),
    }));

    expect(harness.lifecycle.updateRepository).toHaveBeenCalledWith(expect.objectContaining({ visibility: "public" }));
    expect(harness.lifecycle.pauseAutomation).not.toHaveBeenCalled();
  });

  test.each(["repository_removed", "repository_deleted", "installation_suspended", "installation_deleted"] as const)(
    "a pull request of a repository with %s starts nothing",
    async (connectionIssue) => {
      const harness = createHarness(createAutomationContext({ connectionIssue }));

      await expect(harness.orchestrator.process(pullRequestDelivery({ deliveryId: `issue-${connectionIssue}` })))
        .resolves.toEqual({ outcome: "ignored", reason: connectionIssue });
      expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
      expect(harness.mergeTriggers.recordMerge).not.toHaveBeenCalled();
    },
  );
});

describe("Doxabot retries from the pull request check", () => {
  const retriedJobId = "44444444-4444-4444-8444-444444444444";

  function checkRunDelivery(deliveryId: string, action: "rerequested" | "requested_action" = "rerequested"): ProcessGitHubWebhookInput {
    return {
      deliveryId,
      eventName: "check_run",
      rawBody: JSON.stringify({
        action,
        installation: { id: 789 },
        repository: { id: 123456, private: true, default_branch: "main" },
        sender: { id: 7, login: "maintainer" },
        check_run: { id: 9001, name: "Doxa documentation preview", external_id: retriedJobId },
        ...(action === "requested_action" ? { requested_action: { identifier: "retry_preview" } } : {}),
      }),
    };
  }

  test("hands a Re-run to the retry service and records the delivery as processed", async () => {
    const retry = vi.fn(async () => ({ outcome: "started" as const, jobId: "job-new" }));
    const harness = createHarness(createAutomationContext(), null, undefined, { previewRetries: { retry } });

    await expect(harness.orchestrator.process(checkRunDelivery("check-1"))).resolves.toEqual({
      outcome: "enqueued",
      jobId: "job-new",
    });

    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      kind: "review_run_retry",
      jobId: retriedJobId,
      externalRunId: "9001",
      trigger: "rerun",
      requestedBy: { externalId: "7", login: "maintainer" },
    }));
    expect(harness.deliveries.markProcessed).toHaveBeenCalledWith({ provider: "github", deliveryId: "check-1" });
    // A retry is not a push: no new pull request record and no webhook admission.
    expect(harness.changeProposals.ensure).not.toHaveBeenCalled();
    expect(harness.jobs.admitDoxabotJob).not.toHaveBeenCalled();
  });

  test("records a refused retry as ignored with its reason", async () => {
    const retry = vi.fn(async () => ({ outcome: "refused" as const, reason: "not_permitted" as const }));
    const harness = createHarness(createAutomationContext(), null, undefined, { previewRetries: { retry } });

    await expect(harness.orchestrator.process(checkRunDelivery("check-2", "requested_action"))).resolves.toEqual({
      outcome: "ignored",
      reason: "preview_retry_not_permitted",
    });
    expect(harness.deliveries.markIgnored).toHaveBeenCalledWith({
      provider: "github",
      deliveryId: "check-2",
      reason: "preview_retry_not_permitted",
    });
  });

  test("ignores a retry when no retry service is set up", async () => {
    const harness = createHarness();

    await expect(harness.orchestrator.process(checkRunDelivery("check-3"))).resolves.toEqual({
      outcome: "ignored",
      reason: "preview_retry_unavailable",
    });
  });
});

