import { describe, expect, test, vi } from "vitest";
import { CreditsExhaustedError } from "@doxahq/billing";
import type { GenerateJobMessage } from "@doxahq/contracts";
import { billingErrorResponse } from "../../src/http/billing-errors";
import type { GenerationMetering, MeterAdmission } from "../../src/services/billing/generation-metering";
import { ActiveGenerationConflictError, type GenerationRerunSource } from "../../src/repositories/jobs";
import { getResumeBlockedReason } from "../../src/services/generation-actions";
import { GenerationResumeService } from "../../src/services/generation-resume";

const now = new Date("2026-10-16T12:00:00.000Z");
const failedAt = new Date("2026-10-16T10:00:00.000Z");
const resumableStep = { stepName: "write affected production page batch 2 of 3", count: 1, resumable: true };

function run(overrides: Partial<GenerationRerunSource> = {}): GenerationRerunSource {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    status: "failed",
    publicationMode: "production",
    supersededByJobId: null,
    sourceProvider: null,
    sourceInstallationExternalId: null,
    sourceAuthor: null,
    changeExternalId: null,
    change: null,
    productionBranch: "main",
    trigger: "manual",
    baselineVersionId: null,
    plannerModel: null,
    writerModel: null,
    ...overrides,
  };
}

function service(overrides: {
  run?: GenerationRerunSource | null;
  step?: typeof resumableStep | null;
  reopen?: () => Promise<boolean>;
  admission?: MeterAdmission;
  /** The action of the job's earlier hold, or null when the meter holds nothing for it. */
  heldAction?: "generation.run" | "doxabot.run" | null;
} = {}) {
  const sent: GenerateJobMessage[] = [];
  const addEvent = vi.fn(async () => undefined);
  const metering = {
    mode: "on" as const,
    admit: vi.fn<GenerationMetering["admit"]>(async () => overrides.admission ?? { kind: "admitted", metered: true, capCredits: 3000, reservationId: "hold-1" }),
    abandon: vi.fn<GenerationMetering["abandon"]>(async () => undefined),
    heldActionOf: vi.fn<GenerationMetering["heldActionOf"]>(async () => overrides.heldAction ?? null),
    settle: vi.fn<GenerationMetering["settle"]>(async () => undefined),
  };
  const resume = new GenerationResumeService({
    jobs: {
      getRerunSource: async () => (overrides.run === undefined ? run() : overrides.run),
      latestStepFailure: async () => {
        const step = overrides.step === undefined ? resumableStep : overrides.step;
        return step ? { failure: step, failedAt } : null;
      },
      reopenFailedJob: overrides.reopen ?? (async () => true),
      addEvent,
    },
    queue: { send: async (message) => { sent.push(message); } },
    now: () => now,
    ...(overrides.admission ? { metering } : {}),
  });
  return { resume, sent, addEvent, metering };
}

const input = { userId: "owner-1", projectId: "project-1", jobId: "11111111-1111-4111-8111-111111111111" };

describe("resume rules", () => {
  const facts = { status: "failed" as const, publicationMode: "production" as const, failedStep: resumableStep, failedAt, now };

  test("a failed run with a recorded transient failure can continue", () => {
    expect(getResumeBlockedReason(facts)).toBeNull();
  });

  test("a run that did not fail, a failure a retry repeats, or expired steps cannot", () => {
    expect(getResumeBlockedReason({ ...facts, status: "succeeded" })).toBe("not_resumable");
    expect(getResumeBlockedReason({ ...facts, failedStep: { ...resumableStep, resumable: false } })).toBe("not_resumable");
    expect(getResumeBlockedReason({ ...facts, failedStep: null })).toBe("not_resumable");
    expect(getResumeBlockedReason({ ...facts, failedAt: new Date("2026-09-10T00:00:00.000Z") })).toBe("not_resumable");
  });

  test("a preview follows the re-run rules", () => {
    expect(getResumeBlockedReason({ ...facts, publicationMode: "preview", isSuperseded: true })).toBe("superseded");
    expect(getResumeBlockedReason({ ...facts, publicationMode: "preview", changeState: "merged" })).toBe("change_not_open");
  });
});

describe("GenerationResumeService", () => {
  test("reopens the run, records the resume, and asks the worker to continue from the step", async () => {
    const { resume, sent, addEvent } = service();

    await expect(resume.resume(input)).resolves.toEqual({ outcome: "resumed", fromStep: resumableStep.stepName });
    expect(addEvent).toHaveBeenCalledWith(
      input.jobId,
      "generation_resumed",
      expect.stringContaining(resumableStep.stepName),
      { stepName: resumableStep.stepName, count: 1 },
    );
    expect(sent).toEqual([{
      jobId: input.jobId,
      projectId: "project-1",
      userId: "owner-1",
      restartFrom: { name: resumableStep.stepName, count: 1 },
    }]);
  });

  test("does nothing for a run that cannot continue", async () => {
    const { resume, sent } = service({ step: null });
    await expect(resume.resume(input)).resolves.toEqual({ outcome: "blocked", reason: "not_resumable" });
    expect(sent).toEqual([]);
  });

  test("waits for another active run of the project", async () => {
    const { resume, sent } = service({ reopen: async () => { throw new ActiveGenerationConflictError(); } });
    await expect(resume.resume(input)).resolves.toEqual({ outcome: "blocked", reason: "in_progress" });
    expect(sent).toEqual([]);
  });

  test("a run that changed state meanwhile is not resumed twice", async () => {
    const { resume, sent } = service({ reopen: async () => false });
    await expect(resume.resume(input)).resolves.toEqual({ outcome: "blocked", reason: "not_resumable" });
    expect(sent).toEqual([]);
  });

  test("refuses a preview whose pull request ended or left the production branch, as the page does", async () => {
    const preview = { publicationMode: "preview" as const, sourceProvider: "github" as const, changeExternalId: "pr-9" };
    const closed = service({ run: run({ ...preview, change: { state: "closed", baseRef: "main" } }) });
    const offBase = service({ run: run({ ...preview, change: { state: "open", baseRef: "release" } }) });

    await expect(closed.resume.resume(input)).resolves.toEqual({ outcome: "blocked", reason: "change_not_open" });
    await expect(offBase.resume.resume(input)).resolves.toEqual({ outcome: "blocked", reason: "base_not_production" });
    expect([...closed.sent, ...offBase.sent]).toEqual([]);
  });

  test("an unknown run is not found", async () => {
    const { resume } = service({ run: null });
    await expect(resume.resume(input)).resolves.toEqual({ outcome: "not_found" });
  });
});

describe("continuing a run that the credit meter stopped (billing spec 10.6)", () => {
  const stopped = {
    status: "stopped_credits" as const,
    publicationMode: "production" as const,
    failedStep: resumableStep,
    failedAt,
    now,
  };

  test("a stopped run with a recorded stop step can continue", () => {
    expect(getResumeBlockedReason(stopped)).toBeNull();
  });

  test("keeps every other resume guard", () => {
    expect(getResumeBlockedReason({ ...stopped, failedStep: null })).toBe("not_resumable");
    expect(getResumeBlockedReason({ ...stopped, failedStep: { ...resumableStep, resumable: false } })).toBe("not_resumable");
    expect(getResumeBlockedReason({ ...stopped, failedAt: new Date("2026-09-10T00:00:00.000Z") })).toBe("not_resumable");
    expect(getResumeBlockedReason({ ...stopped, publicationMode: "preview", isSuperseded: true })).toBe("superseded");
    expect(getResumeBlockedReason({ ...stopped, publicationMode: "preview", changeState: "closed" })).toBe("change_not_open");
    for (const status of ["queued", "running", "succeeded", "cancelled"] as const) {
      expect(getResumeBlockedReason({ ...stopped, status })).toBe("not_resumable");
    }
  });

  test("holds credits again under a new key, reopens the run and continues from the stop step", async () => {
    const { resume, sent, metering } = service({
      run: run({ status: "stopped_credits" }),
      admission: { kind: "admitted", metered: true, capCredits: 3000, reservationId: "hold-1" },
    });

    await expect(resume.resume(input)).resolves.toEqual({ outcome: "resumed", fromStep: resumableStep.stepName });
    expect(metering.admit).toHaveBeenCalledWith(expect.objectContaining({
      jobId: input.jobId,
      action: "generation.run",
      attempt: expect.stringMatching(/^resume:/),
    }));
    expect(sent).toEqual([expect.objectContaining({ restartFrom: { name: resumableStep.stepName, count: 1 } })]);
  });

  test("a resumed run keeps the action of its original hold", async () => {
    // A warm preview held a doxabot.run; its baseline was collected since, so
    // the row alone would make it cold. The hold decides.
    const warm = service({
      run: run({ status: "stopped_credits", publicationMode: "preview", trigger: "doxabot", baselineVersionId: null }),
      admission: { kind: "admitted", metered: true, capCredits: 500, reservationId: "hold-1" },
      heldAction: "doxabot.run",
    });
    await warm.resume.resume(input);
    expect(warm.metering.heldActionOf).toHaveBeenCalledWith(input.jobId);
    expect(warm.metering.admit).toHaveBeenCalledWith(expect.objectContaining({ action: "doxabot.run", features: ["ai.doxabot"] }));

    // A cold merge run held a generation.run and continues as one.
    const cold = service({
      run: run({ status: "stopped_credits", trigger: "merge", baselineVersionId: "version-1" }),
      admission: { kind: "admitted", metered: true, capCredits: 3000, reservationId: "hold-1" },
      heldAction: "generation.run",
    });
    await cold.resume.resume(input);
    expect(cold.metering.admit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "generation.run", features: ["ai.doxabot", "ai.doxa_agent"] }),
    );
  });

  test("without a hold, a resumed run takes its action from its baseline", async () => {
    const cold = service({
      run: run({ status: "stopped_credits", publicationMode: "preview", trigger: "doxabot", baselineVersionId: null }),
      admission: { kind: "admitted", metered: true, capCredits: 3000, reservationId: "hold-1" },
    });
    await cold.resume.resume(input);
    expect(cold.metering.admit).toHaveBeenCalledWith(expect.objectContaining({ action: "generation.run" }));

    const warm = service({
      run: run({ status: "stopped_credits", publicationMode: "preview", trigger: "doxabot", baselineVersionId: "version-1" }),
      admission: { kind: "admitted", metered: true, capCredits: 500, reservationId: "hold-1" },
    });
    await warm.resume.resume(input);
    expect(warm.metering.admit).toHaveBeenCalledWith(expect.objectContaining({ action: "doxabot.run" }));
  });

  // 2026-11-16 second review: a job holds credits once at a time.
  test("settles a hold that the last try left before it holds credits again", async () => {
    const { resume, metering } = service({ run: run({ status: "stopped_credits" }), admission: { kind: "admitted", metered: true, capCredits: 3000, reservationId: "hold-2" } });
    await resume.resume(input);
    expect(metering.settle).toHaveBeenCalledWith(input.jobId);
    expect(metering.settle.mock.invocationCallOrder[0]).toBeLessThan(metering.admit.mock.invocationCallOrder[0] ?? 0);
  });

  test("a second continue while another one holds credits answers in_progress and reopens nothing", async () => {
    const reopen = vi.fn(async () => true);
    const { resume, sent, metering } = service({ run: run({ status: "stopped_credits" }), admission: { kind: "busy" }, reopen });
    await expect(resume.resume(input)).resolves.toEqual({ outcome: "blocked", reason: "in_progress" });
    expect(reopen).not.toHaveBeenCalled();
    expect(metering.abandon).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test("a continue that still cannot hold credits answers 402 credits_exhausted and does not start", async () => {
    const refusal = new CreditsExhaustedError({
      accountId: "acct-1",
      available: 10,
      needed: 250,
      reason: "monthly_limit",
      resetsAt: null,
    });
    const reopen = vi.fn(async () => true);
    const { resume, sent, addEvent } = service({
      run: run({ status: "stopped_credits" }),
      reopen,
      admission: { kind: "refused", error: refusal },
    });

    const outcome = await resume.resume(input);
    expect(outcome).toEqual({ outcome: "billing_refused", error: refusal });
    expect(reopen).not.toHaveBeenCalled();
    expect(addEvent).not.toHaveBeenCalled();
    expect(sent).toEqual([]);

    const response = billingErrorResponse(refusal);
    expect(response?.status).toBe(402);
    await expect(response?.json()).resolves.toMatchObject({
      error: { details: { code: "credits_exhausted", reason: "monthly_limit", available: 10, needed: 250 } },
    });
  });
});
