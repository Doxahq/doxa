import type { GenerationJobDto } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

// The start service reaches Worker-only modules through its dispatcher.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import type { ChangeProposalRecord } from "../../src/repositories/change-proposals";
import type { DoxabotAutomationContext } from "../../src/repositories/doxabot-settings";
import type { ChangeProposalSnapshot } from "../../src/services/doxabot/change-proposal-state";
import type {
  DoxabotGenerationJobAdmission,
  GenerationRerunSource,
  PreviewRerunJobInput,
} from "../../src/repositories/jobs";
import {
  PreviewGenerationRerunService,
  type PreviewRerunDependencies,
} from "../../src/services/doxabot/preview-rerun";
import { GenerationRerunService } from "../../src/services/generation-rerun";
import type { GenerationStartOutcome } from "../../src/services/generation-start";

const projectId = "11111111-1111-4111-8111-111111111111";
const headSha = "c".repeat(40);

function job(overrides: Partial<GenerationJobDto> = {}): GenerationJobDto {
  return {
    id: "job-new",
    projectId,
    status: "queued",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-10-15T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    ...overrides,
  };
}

function failedRun(overrides: Partial<GenerationRerunSource> = {}): GenerationRerunSource {
  return {
    id: "job-failed",
    projectId,
    status: "failed",
    publicationMode: "preview",
    supersededByJobId: null,
    sourceProvider: "github",
    sourceInstallationExternalId: "789",
    sourceAuthor: { externalId: "42", handle: "octocat", avatarUrl: null },
    changeExternalId: "pr-9",
    change: { state: "open", baseRef: "main" },
    productionBranch: "main",
    trigger: "doxabot",
    baselineVersionId: "version-1",
    plannerModel: null,
    writerModel: null,
    ...overrides,
  };
}

function proposal(overrides: Partial<ChangeProposalRecord> = {}): ChangeProposalRecord {
  return {
    id: "proposal-1",
    projectId,
    provider: "github",
    repositoryExternalId: "123456",
    installationExternalId: "789",
    externalId: "pr-9",
    displayNumber: 9,
    draft: false,
    state: "open",
    defaultBranch: "main",
    baseRef: "main",
    baseRevision: "a".repeat(40),
    headRevision: headSha,
    sourceUpdatedAt: new Date("2026-10-15T10:00:00.000Z"),
    lastSourceTreeHash: null,
    ...overrides,
  };
}

function automationContext(overrides: Partial<DoxabotAutomationContext> = {}): DoxabotAutomationContext {
  return {
    projectId,
    ownerUserId: "owner-user",
    repositoryExternalId: "123456",
    installationExternalId: "789",
    repositoryOwner: "ipenywis",
    repositoryName: "flagforge",
    repositoryVisibility: "private",
    productionBranch: "main",
    // A person asks for the run, so automatic previews being off does not stop it.
    storedEnabled: false,
    mergeTrigger: "batched",
    hasPublishedVersion: true,
    publishedBaseline: { versionId: "version-live", sourceRevision: "a".repeat(40) },
    ...overrides,
  };
}

function previewSetup(input: {
  proposal?: ChangeProposalRecord | null;
  active?: GenerationJobDto | null;
  admission?: DoxabotGenerationJobAdmission;
  queueFails?: boolean;
  context?: Partial<DoxabotAutomationContext>;
  /** The pull request on GitHub now; by default it matches the record. "unavailable" makes GitHub fail. */
  live?: Partial<ChangeProposalSnapshot> | "unavailable";
  /** The last successful preview of the pull request (the warm baseline), or null. */
  previewBaseline?: { versionId: string; sourceRevision: string } | null;
  /** Meter the run (BILLING_ENFORCEMENT=on). */
  metered?: boolean;
} = {}) {
  const admitted: PreviewRerunJobInput[] = [];
  const metering = {
    mode: "on" as const,
    admit: vi.fn(async () => ({ kind: "admitted" as const, metered: true, capCredits: 500, reservationId: "hold-1" })),
    abandon: vi.fn(async () => undefined),
  };
  const jobs = {
    isGenerationPaused: vi.fn(async () => false),
    activeForConcurrencyKey: vi.fn(async () => input.active ?? null),
    admitPreviewRerun: vi.fn(async (admission: PreviewRerunJobInput) => {
      admitted.push(admission);
      return input.admission ?? { outcome: "created" as const, job: job(), queuePublished: false, supersededJobId: null };
    }),
    markFailed: vi.fn(async () => true),
    addEvent: vi.fn(async () => undefined),
  };
  const queue = {
    send: vi.fn(async () => {
      if (input.queueFails) throw new Error("queue down");
    }),
  };
  const reviewRuns = {
    create: vi.fn(async () => ({ externalRunId: "9001", outcome: "created" as const })),
    update: vi.fn(async () => ({ externalRunId: "9001", outcome: "updated" as const })),
  };
  const deps: PreviewRerunDependencies = {
    jobs,
    settings: { getAutomationContext: vi.fn(async () => automationContext(input.context)) },
    changeProposals: {
      getByIdentity: vi.fn(async () => (input.proposal === undefined ? proposal() : input.proposal)),
    },
    previewBaselines: {
      findSuccessfulCompatiblePreview: vi.fn(async () => (input.previewBaseline ?? null) as never),
    },
    ...(input.metered ? { metering } : {}),
    queue,
    reviewRuns,
    deploymentPolicy: { enabled: true, publicRepositoriesEnabled: false },
    executionConfig: {
      plannerModel: "planner",
      writerModel: "writer",
      generationProfile: "full-prod",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generatorFingerprint: "generator-v1",
    },
    pullRequests: {
      getCurrentForJob: vi.fn(async (): Promise<ChangeProposalSnapshot> => {
        if (input.live === "unavailable") throw new Error("GitHub unavailable");
        const stored = input.proposal ?? proposal();
        return {
          externalId: stored.externalId,
          number: stored.displayNumber,
          draft: stored.draft,
          state: stored.state,
          baseRef: stored.baseRef,
          baseRevision: stored.baseRevision,
          headRevision: stored.headRevision,
          sourceUpdatedAt: stored.sourceUpdatedAt,
          ...input.live,
        };
      }),
    },
  };
  return { service: new PreviewGenerationRerunService(deps), admitted, jobs, queue, reviewRuns, metering };
}

describe("preview generation re-run", () => {
  test("starts a new run on the pull request's head with a key of its own", async () => {
    const { service, admitted, queue, reviewRuns } = previewSetup();

    await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "started", job: job() });

    expect(admitted[0]).toMatchObject({
      changeProposalId: "proposal-1",
      targetRevision: headSha,
      baselineRevision: "a".repeat(40),
      baselineVersionId: "version-live",
      rerunOfJobId: "job-failed",
      sourceAuthor: { handle: "octocat" },
    });
    expect(admitted[0]?.idempotencyKey).toMatch(/:rerun:/);
    expect(reviewRuns.create).toHaveBeenCalledWith("job-new", expect.objectContaining({ sourceRevision: headSha }));
    expect(queue.send).toHaveBeenCalledWith({ jobId: "job-new", projectId, userId: "owner-user" });
  });

  test("gives every re-run a different key", async () => {
    const { service, admitted } = previewSetup();

    await service.rerun(failedRun());
    await service.rerun(failedRun());

    expect(admitted[0]?.idempotencyKey).not.toBe(admitted[1]?.idempotencyKey);
  });

  test("refuses a pull request that is no longer open", async () => {
    for (const closed of [proposal({ state: "merged" }), proposal({ state: "closed" }), proposal({ draft: true })]) {
      const { service, admitted } = previewSetup({ proposal: closed });
      await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "blocked", reason: "change_not_open" });
      expect(admitted).toHaveLength(0);
    }
  });

  test("refuses a pull request that GitHub reports on another base, before Doxa has seen the change", async () => {
    const { service, admitted } = previewSetup({ live: { baseRef: "release" } });

    await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "blocked", reason: "base_not_production" });
    expect(admitted).toHaveLength(0);
  });

  test("refuses a pull request that GitHub reports closed", async () => {
    const { service, admitted } = previewSetup({ live: { state: "closed" } });

    await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "blocked", reason: "change_not_open" });
    expect(admitted).toHaveLength(0);
  });

  test("refuses the recorded head when GitHub already has a newer one", async () => {
    const { service, admitted } = previewSetup({ live: { headRevision: "f".repeat(40) } });

    await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "blocked", reason: "superseded" });
    expect(admitted).toHaveLength(0);
  });

  test("falls back to the record when GitHub cannot answer", async () => {
    const { service } = previewSetup({ live: "unavailable" });

    await expect(service.rerun(failedRun())).resolves.toMatchObject({ outcome: "started" });
  });

  test("refuses a pull request that no longer targets the production branch", async () => {
    // The pull request targets main; the project moved production to release.
    const { service, admitted } = previewSetup({ context: { productionBranch: "release" } });

    await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "blocked", reason: "base_not_production" });
    expect(admitted).toHaveLength(0);
  });

  test("guards the admission with the record that it read", async () => {
    const { service, admitted } = previewSetup();

    await service.rerun(failedRun());

    expect(admitted[0]?.guard).toEqual({ seen: proposal(), productionBranch: "main" });
  });

  test.each([
    { stop: "closed", reason: "change_not_open" },
    { stop: "merged", reason: "change_not_open" },
    { stop: "retargeted", reason: "base_not_production" },
    { stop: "superseded", reason: "superseded" },
  ] as const)("answers $reason when the pull request was $stop during the re-run", async ({ stop, reason }) => {
    const { service, queue, reviewRuns } = previewSetup({
      admission: { outcome: "stale_change", reason: stop },
    });

    await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "blocked", reason });
    expect(reviewRuns.create).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  test("runs without a baseline after the generation cache was cleared", async () => {
    const { service, admitted } = previewSetup({ context: { publishedBaseline: null } });

    await expect(service.rerun(failedRun())).resolves.toMatchObject({ outcome: "started" });
    expect(admitted[0]).toMatchObject({ baselineVersionId: null, baselineRevision: null });
  });

  test("a re-run without a baseline is metered as a full generation (generation.run)", async () => {
    const { service, admitted, metering } = previewSetup({ context: { publishedBaseline: null }, metered: true });
    await expect(service.rerun(failedRun())).resolves.toMatchObject({ outcome: "started" });
    expect(metering.admit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "generation.run", features: ["ai.doxabot", "ai.doxa_agent"] }),
    );
    expect(admitted[0]).toMatchObject({ baselineVersionId: null });
  });

  test("a re-run with a baseline stays a doxabot.run, from the last preview or the published version", async () => {
    const published = previewSetup({ metered: true });
    await published.service.rerun(failedRun());
    expect(published.metering.admit).toHaveBeenCalledWith(expect.objectContaining({ action: "doxabot.run", features: ["ai.doxabot"] }));
    expect(published.admitted[0]).toMatchObject({ baselineVersionId: "version-live" });

    const preview = previewSetup({
      context: { publishedBaseline: null },
      previewBaseline: { versionId: "version-preview", sourceRevision: "e".repeat(40) },
      metered: true,
    });
    await preview.service.rerun(failedRun());
    expect(preview.metering.admit).toHaveBeenCalledWith(expect.objectContaining({ action: "doxabot.run" }));
    expect(preview.admitted[0]).toMatchObject({ baselineVersionId: "version-preview" });
  });

  test("opens the active run of the pull request instead of a second one", async () => {
    const active = job({ id: "job-active", status: "running" });
    const { service, admitted } = previewSetup({ active });

    await expect(service.rerun(failedRun())).resolves.toEqual({ outcome: "already_active", job: active });
    expect(admitted).toHaveLength(0);
  });

  test("fails the new run and its check when the queue refuses it", async () => {
    const { service, jobs, reviewRuns } = previewSetup({ queueFails: true });

    const outcome = await service.rerun(failedRun());

    expect(outcome.outcome).toBe("dispatch_failed");
    expect(jobs.markFailed).toHaveBeenCalledWith("job-new", expect.any(String));
    expect(reviewRuns.update).toHaveBeenCalledWith("job-new", expect.objectContaining({ externalRunId: "9001" }));
  });
});

describe("generation re-run", () => {
  function setup(source: GenerationRerunSource | null) {
    const jobs = {
      getRerunSource: vi.fn(async () => source),
      addEvent: vi.fn(async () => undefined),
    };
    const production = {
      start: vi.fn(async (): Promise<GenerationStartOutcome> => ({ outcome: "started", job: job() })),
    };
    const preview = { rerun: vi.fn(async () => ({ outcome: "started" as const, job: job() })) };
    const service = new GenerationRerunService({ jobs, production, preview });
    const input = { userId: "owner-user", projectId, jobId: "job-failed", force: true };
    return { service, jobs, production, preview, input };
  }

  test("starts a failed production run like a person's run", async () => {
    const { service, production, preview, jobs, input } = setup(failedRun({ publicationMode: "production" }));

    await expect(service.rerun(input)).resolves.toMatchObject({ outcome: "started" });

    expect(production.start).toHaveBeenCalledWith({
      userId: "owner-user",
      projectId,
      force: true,
      seed: undefined,
      trigger: "manual",
    });
    expect(preview.rerun).not.toHaveBeenCalled();
    expect(jobs.addEvent).toHaveBeenCalledWith("job-failed", "rerun_started", expect.any(String), {
      jobId: "job-new",
    });
    expect(jobs.addEvent).toHaveBeenCalledWith("job-new", "rerun_of", expect.any(String), {
      jobId: "job-failed",
    });
  });

  test("leaves the pull request's state to the preview service, which reads it live", async () => {
    // The record says another base; GitHub may say otherwise, so only the preview service decides.
    const failed = failedRun({ change: { state: "open", baseRef: "release" } });
    const { service, preview, input } = setup(failed);

    await service.rerun(input);

    expect(preview.rerun).toHaveBeenCalledWith(failed);
  });

  test("starts a failed preview run on its pull request", async () => {
    const failed = failedRun();
    const { service, production, preview, input } = setup(failed);

    await service.rerun(input);

    expect(preview.rerun).toHaveBeenCalledWith(failed);
    expect(production.start).not.toHaveBeenCalled();
  });

  test("links no run when the re-run did not start", async () => {
    const { service, jobs, production, input } = setup(failedRun({ publicationMode: "production" }));
    production.start.mockResolvedValueOnce({ outcome: "already_active", job: job({ id: "job-active", status: "running" }) });

    await service.rerun(input);

    expect(jobs.addEvent).not.toHaveBeenCalled();
  });

  test("asks before it runs a succeeded run again", async () => {
    const asked = setup(failedRun({ status: "succeeded", publicationMode: "production" }));
    await expect(asked.service.rerun({ ...asked.input, force: false })).resolves.toEqual({
      outcome: "confirmation_required",
      reason: "rerun_succeeded",
      message: expect.stringContaining("similar result"),
    });
    expect(asked.production.start).not.toHaveBeenCalled();
    expect(asked.jobs.addEvent).not.toHaveBeenCalled();

    const confirmed = setup(failedRun({ status: "succeeded", publicationMode: "production" }));
    await expect(confirmed.service.rerun(confirmed.input)).resolves.toMatchObject({ outcome: "started" });
    expect(confirmed.production.start).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  test("runs a cancelled run again without asking", async () => {
    const { service, production, input } = setup(failedRun({ status: "cancelled", publicationMode: "production" }));

    await expect(service.rerun({ ...input, force: false })).resolves.toMatchObject({ outcome: "started" });
    expect(production.start).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  test("asks before it runs a succeeded preview run again", async () => {
    const { service, preview, input } = setup(failedRun({ status: "succeeded" }));

    await expect(service.rerun({ ...input, force: false })).resolves.toMatchObject({
      outcome: "confirmation_required",
      reason: "rerun_succeeded",
    });
    expect(preview.rerun).not.toHaveBeenCalled();
  });

  test("runs again only an ended run that nothing replaced", async () => {
    const running = setup(failedRun({ status: "running" }));
    await expect(running.service.rerun(running.input)).resolves.toEqual({ outcome: "blocked", reason: "not_finished" });

    const replaced = setup(failedRun({ supersededByJobId: "job-newer" }));
    await expect(replaced.service.rerun(replaced.input)).resolves.toEqual({ outcome: "blocked", reason: "superseded" });

    const missing = setup(null);
    await expect(missing.service.rerun(missing.input)).resolves.toEqual({ outcome: "not_found" });
  });
});
