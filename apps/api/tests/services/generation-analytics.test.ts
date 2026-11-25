import { describe, expect, test } from "vitest";
import type { GenerationEndFacts } from "../../src/repositories/generation-analytics";
import { reportGenerationFinished, reportGenerationFinishedInBackground } from "../../src/services/generation-analytics";
import type { Env } from "../../src/env";
import { recordingProductAnalytics } from "../support/recording-product-analytics";

const CREATED = new Date("2026-11-20T10:00:00Z");

function facts(overrides: Partial<GenerationEndFacts> = {}): GenerationEndFacts {
  return {
    projectId: "project-1",
    status: "succeeded",
    trigger: "manual",
    publicationMode: "production",
    userId: "user-1",
    createdAt: CREATED,
    endedAt: new Date(CREATED.getTime() + 95_500),
    ...overrides,
  };
}

async function report(row: GenerationEndFacts | null, details?: Parameters<typeof reportGenerationFinished>[2]) {
  const recording = recordingProductAnalytics();
  reportGenerationFinished({ facts: { endFacts: async () => row }, analytics: recording.analytics }, "job-1", details);
  return recording.events();
}

describe("generation_finished", () => {
  test("reports the stored end state, the duration and the pages written", async () => {
    expect(await report(facts(), { pagesWritten: 12 })).toEqual([
      {
        kind: "event",
        event: "generation_finished",
        distinctId: "user-1",
        properties: { trigger: "manual", outcome: "succeeded", duration_s: 95.5, pages_written: 12 },
        groups: { project: "project-1" },
      },
    ]);
  });

  test("a credit stop carries its machine reason as the error code", async () => {
    const [event] = await report(facts({ status: "stopped_credits" }), { stopReason: "credit_cap" });
    expect(event?.properties).toMatchObject({ outcome: "stopped_credits", error_code: "credit_cap" });
  });

  test("a pull request run also reports doxabot_run_finished", async () => {
    const events = await report(facts({ trigger: "doxabot", publicationMode: "preview", status: "cancelled" }), { pagesWritten: 3 });
    expect(events.map((event) => event.event)).toEqual(["generation_finished", "doxabot_run_finished"]);
    expect(events[1]?.properties).toEqual({ outcome: "cancelled", pages_changed: 3 });
  });

  test("a job that has not ended, or is gone, reports nothing", async () => {
    expect(await report(facts({ status: "running" }))).toEqual([]);
    expect(await report(null)).toEqual([]);
  });

  test("without analytics it reads nothing", () => {
    // No database in this env: a read would fail; the no-op returns first.
    expect(() => reportGenerationFinishedInBackground({} as Env, "job-1")).not.toThrow();
  });
});
