import { describe, expect, test, vi } from "vitest";
import type { GenerateJobMessage } from "@doxahq/contracts";
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
    ...overrides,
  };
}

function service(overrides: {
  run?: GenerationRerunSource | null;
  step?: typeof resumableStep | null;
  reopen?: () => Promise<boolean>;
} = {}) {
  const sent: GenerateJobMessage[] = [];
  const addEvent = vi.fn(async () => undefined);
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
  });
  return { resume, sent, addEvent };
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
