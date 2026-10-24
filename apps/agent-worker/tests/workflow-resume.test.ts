import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
  DurableObject: class {},
}));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));

import type { Env } from "../src/index";
import { restartGenerationWorkflow } from "../src/index";
import { withResumedBudgetStart } from "../src/generation-workflow-runtime";
import { isResumableStepError, trackWorkflowSteps } from "../src/workflow-step-tracker";

const message = { jobId: "11111111-1111-4111-8111-111111111111", projectId: "p", userId: "u" };

function directStep() {
  return { do: <T,>(_name: string, _config: unknown, callback: () => Promise<T>) => callback() };
}

describe("workflow step tracker", () => {
  test("finds the step whose error ended the run, not an earlier handled failure", async () => {
    const tracker = trackWorkflowSteps(directStep());
    const handled = new Error("internal error; reference = abc");
    await tracker.step.do("write page batch 1 of 2", {}, async () => {
      throw handled;
    }).catch(() => undefined);
    const fatal = new Error("Container stage failed");
    await tracker.step.do("assemble and upload production artifacts", {}, async () => {
      throw fatal;
    }).catch(() => undefined);

    expect(tracker.failureOf(fatal)).toEqual({
      stepName: "assemble and upload production artifacts",
      count: 1,
      resumable: true,
    });
    expect(tracker.failureOf(new Error("Container stage failed"))?.stepName)
      .toBe("assemble and upload production artifacts");
    expect(tracker.failureOf(new Error("thrown outside any step"))).toBeNull();
  });

  test("a failure that a retry repeats cannot continue", () => {
    const nonRetryable = Object.assign(new Error("Write stage returned an invalid checkpoint."), {
      name: "NonRetryableError",
    });
    expect(isResumableStepError(nonRetryable)).toBe(false);
    expect(isResumableStepError(new Error("Generation job is no longer active."))).toBe(false);
    expect(isResumableStepError(new Error("Model provider error (spend_cap): no credit"))).toBe(false);
    expect(isResumableStepError(new Error("45 of 51 pages could not be written, so the run stopped instead of publishing an incomplete site."))).toBe(false);
    expect(isResumableStepError(new Error("internal error; reference = abc"))).toBe(true);
  });
});

describe("resumed time budget", () => {
  const event = { payload: message, timestamp: new Date("2026-10-15T10:00:00.000Z") };

  test("a resumed run counts its budget from the resume", async () => {
    const env = { API: { getGenerationResumedAt: async () => "2026-10-16T09:00:00.000Z" } } as unknown as Env;
    expect((await withResumedBudgetStart(env, event)).timestamp.toISOString()).toBe("2026-10-16T09:00:00.000Z");
  });

  test("a run that was never resumed, or an API that cannot answer, keeps its start", async () => {
    const never = { API: { getGenerationResumedAt: async () => null } } as unknown as Env;
    const failing = { API: { getGenerationResumedAt: async () => { throw new Error("down"); } } } as unknown as Env;
    expect(await withResumedBudgetStart(never, event)).toBe(event);
    expect(await withResumedBudgetStart(failing, event)).toBe(event);
  });
});

describe("restart from the failed step", () => {
  test("continues the run's own Workflow instance from the step", async () => {
    const restart = vi.fn(async () => undefined);
    const env = {
      GENERATION_WORKFLOW: { get: async () => ({ restart }) },
      API: { markJobFailed: vi.fn(), addJobEvent: vi.fn() },
    } as unknown as Env;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await restartGenerationWorkflow(env, message, { name: "write affected production page batch 2 of 3" });

    expect(restart).toHaveBeenCalledWith({ from: { name: "write affected production page batch 2 of 3" } });
    expect(env.API.markJobFailed).not.toHaveBeenCalled();
  });

  test("a run whose saved steps are gone fails again and says to re-run it", async () => {
    const markJobFailed = vi.fn(async () => undefined);
    const env = {
      GENERATION_WORKFLOW: { get: async () => { throw new Error("instance.not_found"); } },
      API: { markJobFailed, addJobEvent: vi.fn(async () => undefined) },
    } as unknown as Env;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await restartGenerationWorkflow(env, message, { name: "plan exact production revision" });

    expect(markJobFailed).toHaveBeenCalledWith(message.jobId, expect.stringContaining("Re-run it instead."));
  });
});
