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
      },
      pull_request: {
        id: 987654,
        user: {
          id: 1,
          login: "octocat",
          avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
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
      publicRepositoriesEnabled: false,
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
    now: () => new Date(closedAt),
  } satisfies DoxabotWebhookDependencies;

  return {
    orchestrator: new DoxabotWebhookOrchestrator(dependencies),
    mergeTriggers,
    previewJobs,
    previewChannels,
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
    expect(harness.queue.send).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "job-2" }));
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
