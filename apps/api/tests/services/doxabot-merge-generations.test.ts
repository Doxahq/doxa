import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import type { MergeCandidate } from "../../src/repositories/pending-merges";
import {
  isMergeRunDue,
  MergeGenerationScheduler,
} from "../../src/services/doxabot/merge-generations";
import type { GenerationStartOutcome } from "../../src/services/generation-start";

const now = new Date("2026-10-11T12:00:00.000Z");

function candidate(overrides: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    projectId: "project-1",
    ownerUserId: "owner-1",
    mergeTrigger: "batched",
    batchQuietMinutes: 30,
    lastMergedAt: new Date("2026-10-11T11:00:00.000Z"),
    ...overrides,
  };
}

function scheduler(
  candidates: MergeCandidate[],
  outcome: GenerationStartOutcome["outcome"] = "started",
) {
  const merges = {
    record: vi.fn(async () => undefined),
    candidates: vi.fn(async () => candidates),
    markAttempted: vi.fn(async () => undefined),
  };
  const start = vi.fn(async () => outcome);
  return {
    merges,
    start,
    service: new MergeGenerationScheduler({ merges, start, now: () => now }),
  };
}

describe("isMergeRunDue", () => {
  test("waits for the quiet time after the last merge", () => {
    expect(isMergeRunDue(candidate({ lastMergedAt: new Date("2026-10-11T11:40:00.000Z") }), now)).toBe(false);
    expect(isMergeRunDue(candidate({ lastMergedAt: new Date("2026-10-11T11:30:00.000Z") }), now)).toBe(true);
  });

  test("runs at once for every merge", () => {
    expect(
      isMergeRunDue(candidate({ mergeTrigger: "every_merge", lastMergedAt: now }), now),
    ).toBe(true);
  });
});

describe("MergeGenerationScheduler", () => {
  test("starts a run for due projects and marks their merges as tried", async () => {
    const { merges, start, service } = scheduler([
      candidate(),
      candidate({ projectId: "project-2", lastMergedAt: new Date("2026-10-11T11:55:00.000Z") }),
    ]);

    await expect(service.run()).resolves.toBe(1);

    expect(start).toHaveBeenCalledWith({ projectId: "project-1", ownerUserId: "owner-1" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(merges.markAttempted).toHaveBeenCalledWith({ projectId: "project-1", until: now });
  });

  test("tries again later when another run is active", async () => {
    const { merges, service } = scheduler([candidate()], "already_active");

    await expect(service.run()).resolves.toBe(0);

    expect(merges.markAttempted).not.toHaveBeenCalled();
  });

  test("does not repeat a start that needs a person", async () => {
    const { merges, service } = scheduler([candidate()], "confirmation_required");

    await expect(service.run()).resolves.toBe(0);

    expect(merges.markAttempted).toHaveBeenCalledOnce();
  });

  test("starts at once for every merge and waits for the cron otherwise", async () => {
    const everyMerge = scheduler([candidate({ mergeTrigger: "every_merge" })]);
    const batched = scheduler([candidate()]);
    const merge = {
      projectId: "project-1",
      changeExternalId: "pr-1",
      changeNumber: 7,
      mergedAt: now,
    }

    await everyMerge.service.recordMerge({ ...merge, mergeTrigger: "every_merge" });
    await batched.service.recordMerge({ ...merge, mergeTrigger: "batched" });

    expect(everyMerge.merges.record).toHaveBeenCalledWith(merge);
    expect(everyMerge.start).toHaveBeenCalledOnce();
    expect(batched.merges.record).toHaveBeenCalledWith(merge);
    expect(batched.start).not.toHaveBeenCalled();
  });
});
