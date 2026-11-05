import { describe, expect, it, vi } from "vitest";

import {
  runMaintenanceSteps,
  type DocsSearchMaintenanceSteps,
} from "../../../src/services/docs-search/maintenance";

const never = () => new Promise<never>(() => {});

function steps(overrides: Partial<DocsSearchMaintenanceSteps> = {}) {
  return {
    sweep: vi.fn(async (_signal: AbortSignal) => {}),
    runTasks: vi.fn(async (_signal: AbortSignal) => {}),
    recheck: vi.fn(async (_signal: AbortSignal) => {}),
    rollUpUsage: vi.fn(async (_signal: AbortSignal) => {}),
    ...overrides,
  };
}

const BUDGETS = { runMs: 300, sweepMs: 10, taskMs: 30 };

describe("docs search maintenance", () => {
  it("runs the steps in order", async () => {
    const order: string[] = [];
    await runMaintenanceSteps(
      steps({
        sweep: async () => void order.push("sweep"),
        runTasks: async () => void order.push("tasks"),
        recheck: async () => void order.push("recheck"),
        rollUpUsage: async () => void order.push("usage"),
      }),
      BUDGETS,
    );
    expect(order).toEqual(["sweep", "tasks", "recheck", "usage"]);
  });

  // PRODUCT REGRESSION GUARDRAIL: a stalled task must not starve the rechecks.
  it("moves on to the rechecks when a task stalls", async () => {
    const recheck = vi.fn(async (_signal: AbortSignal) => {});
    await runMaintenanceSteps(steps({ runTasks: never, recheck }), BUDGETS);
    expect(recheck).toHaveBeenCalledOnce();
    expect(recheck.mock.calls[0]?.[0].aborted).toBe(false);
  });

  // PRODUCT REGRESSION GUARDRAIL: each deadline counts from the start of the run.
  it("keeps the time for rechecks after a slow sweep and a stalled task", async () => {
    const recheck = vi.fn(async (_signal: AbortSignal) => {});
    await runMaintenanceSteps(
      steps({
        sweep: () => new Promise((resolve) => setTimeout(resolve, 20)),
        runTasks: never,
        recheck,
      }),
      { runMs: 100, sweepMs: 30, taskMs: 40 },
    );
    expect(recheck.mock.calls[0]?.[0].aborted).toBe(false);
  });

  // PRODUCT REGRESSION GUARDRAIL: one locked row must not stop all builds.
  it("leaves time for tasks and rechecks when the sweep stalls", async () => {
    const recheck = vi.fn(async (_signal: AbortSignal) => {});
    const runTasks = vi.fn(async (_signal: AbortSignal) => {});
    let sweepSignal: AbortSignal | undefined;
    await runMaintenanceSteps(
      steps({
        sweep: (signal) => {
          sweepSignal = signal;
          return never();
        },
        runTasks,
        recheck,
      }),
      BUDGETS,
    );
    expect(sweepSignal?.aborted).toBe(true);
    expect(runTasks.mock.calls[0]?.[0].aborted).toBe(false);
    expect(recheck.mock.calls[0]?.[0].aborted).toBe(false);
  });

  it("logs a sweep that fails after its deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runMaintenanceSteps(
      steps({
        sweep: () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("late")), 20),
          ),
      }),
      { runMs: 200, sweepMs: 5, taskMs: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(warn.mock.calls.flat().join()).toContain("docs_search_late_failure");
    warn.mockRestore();
  });

  it("gives tasks a signal that ends with their share", async () => {
    let taskSignal: AbortSignal | undefined;
    await runMaintenanceSteps(
      steps({
        runTasks: (signal) => {
          taskSignal = signal;
          return never();
        },
      }),
      BUDGETS,
    );
    expect(taskSignal?.aborted).toBe(true);
  });

  // PRODUCT REGRESSION GUARDRAIL: a stalled step must not hold other cron jobs.
  it("ends at the whole budget, whatever step stalls", async () => {
    for (const stalled of ["recheck", "rollUpUsage"] as const) {
      await expect(
        runMaintenanceSteps(steps({ [stalled]: never }), {
          runMs: 30,
          sweepMs: 5,
          taskMs: 10,
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    }
  });

  it("reports a task failure that is not the budget", async () => {
    const recheck = vi.fn(async (_signal: AbortSignal) => {});
    await expect(
      runMaintenanceSteps(
        steps({
          runTasks: async () => {
            throw new Error("database down");
          },
          recheck,
        }),
        BUDGETS,
      ),
    ).rejects.toThrow("database down");
    expect(recheck).not.toHaveBeenCalled();
  });
});
