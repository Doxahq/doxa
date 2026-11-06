import { type PageNotice } from "@doxahq/contracts/generation-reviews";
import { describe, expect, test } from "vitest";
import { checkPageFailureBudgetStep } from "../src/best-effort-step";
import { assertPageFailureBudget, type FailedGenerationPage } from "../src/generation-page-failures";
import type { GenerationWorkflowStep } from "../src/generation-workflow-runtime";
import { trackWorkflowSteps } from "../src/workflow-step-tracker";
import {
  EMPTY_PAGE_NOTICE_PAYLOAD,
  pageNoticePayloadKey,
  readPageNoticePayload,
  storePageNoticePayload,
  writePhaseOutcomeOf,
  type WritePhaseOutcome,
} from "../src/write-phase-outcome";

function memoryBucket() {
  const objects = new Map<string, string>();
  const bucket: Pick<R2Bucket, "get" | "put"> = {
    get: async (key: string) => {
      const text = objects.get(key);
      return text === undefined ? null : ({ text: async () => text } as R2ObjectBody);
    },
    put: async (key: string, value: unknown) => {
      objects.set(key, String(value));
      return null;
    },
  } as Pick<R2Bucket, "get" | "put">;
  return { bucket, objects };
}

function failed(id: string): FailedGenerationPage {
  return { id, title: id, reason: "The page batch failed." };
}

function runStep(): GenerationWorkflowStep {
  return { do: async (_name, _config, callback) => callback() };
}

describe("a recorded write phase outcome", () => {
  test("a result recorded before the write phase grew gets the behavior of its code", () => {
    const outcome = writePhaseOutcomeOf(
      { keys: ["pages/0.json"], failedPages: [failed("b")] },
      ["a", "b", "c"],
    );

    expect(outcome).toEqual({
      keys: ["pages/0.json"],
      failedPages: [failed("b")],
      budgeted: { failedPages: [failed("b")], plannedCount: 3 },
      writtenPageIds: ["a", "c"],
      runFingerprint: null,
      catchUpPageIds: [],
      publishedBehindPageIds: [],
      noticesKey: null,
    });
  });

  test("a current result is kept as recorded", () => {
    const recorded: WritePhaseOutcome = {
      keys: [],
      failedPages: [failed("guide")],
      budgeted: { failedPages: [], plannedCount: 2 },
      writtenPageIds: ["home"],
      runFingerprint: "fp",
      catchUpPageIds: ["guide"],
      publishedBehindPageIds: ["guide"],
      noticesKey: "checkpoints/job/production-page-notices.json",
    };

    expect(writePhaseOutcomeOf(recorded, ["home", "guide"])).toEqual(recorded);
  });
});

describe("the page notice payload", () => {
  const issues = Array.from({ length: 10 }, (_, index) => ({
    check: "instructionTerminology",
    message: `Say "repository", not "repo" (${index}). ${"x".repeat(200)}`,
    instructions: true,
  }));
  const notices: PageNotice[] = Array.from({ length: 200 }, (_, index) => ({
    pageId: `page-${index}`,
    title: `Page ${index} ${"t".repeat(180)}`,
    href: `/page-${index}`,
    kind: "open_issues",
    issues,
  }));

  test("200 pages with 10 issues each travel through R2, and the step result keeps only the key", async () => {
    const { bucket } = memoryBucket();
    const key = pageNoticePayloadKey("checkpoints/job-1", "production");

    const storedKey = await storePageNoticePayload(bucket, key, { openIssueNotices: notices, behindCandidates: [] });
    const stepResult: WritePhaseOutcome = {
      keys: ["checkpoints/job-1/production-pages/0.json"],
      failedPages: [],
      budgeted: { failedPages: [], plannedCount: 200 },
      writtenPageIds: notices.map((notice) => notice.pageId),
      runFingerprint: "fp",
      catchUpPageIds: [],
      publishedBehindPageIds: [],
      noticesKey: storedKey,
    };

    expect(storedKey).toBe(key);
    expect(JSON.stringify(stepResult).length).toBeLessThan(16 * 1024);
    await expect(readPageNoticePayload(bucket, storedKey)).resolves.toEqual({
      openIssueNotices: notices,
      behindCandidates: [],
    });
  });

  test("a run without notices stores nothing, and its notice step reads nothing", async () => {
    const { bucket, objects } = memoryBucket();

    await expect(storePageNoticePayload(bucket, "k", EMPTY_PAGE_NOTICE_PAYLOAD)).resolves.toBeNull();
    expect(objects.size).toBe(0);
    await expect(readPageNoticePayload(bucket, null)).resolves.toEqual(EMPTY_PAGE_NOTICE_PAYLOAD);
  });

  test("a missing or malformed payload throws, which the notice step logs and skips", async () => {
    const { bucket, objects } = memoryBucket();
    objects.set("bad", JSON.stringify({ openIssueNotices: "nope" }));

    await expect(readPageNoticePayload(bucket, "absent")).rejects.toThrow("missing");
    await expect(readPageNoticePayload(bucket, "bad")).rejects.toThrow();
  });
});

describe("the page failure budget step", () => {
  test("a busted budget fails in its own step, so the run names the step it stopped at", async () => {
    const tracker = trackWorkflowSteps(runStep());
    const budgeted = { failedPages: [failed("a"), failed("b"), failed("c"), failed("d")], plannedCount: 5 };
    const expected = (() => {
      try {
        assertPageFailureBudget(budgeted.failedPages, budgeted.plannedCount);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    })();

    const run = checkPageFailureBudgetStep({
      step: tracker.step,
      name: "check production page failure budget",
      config: {},
      budgeted,
    });

    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toBe(expected);
    expect(expected).toContain("4 of 5 pages could not be written");
    expect(tracker.failureOf(error)).toEqual({
      stepName: "check production page failure budget",
      count: 1,
      resumable: false,
    });
  });

  test("a budget that holds passes without effect", async () => {
    const tracker = trackWorkflowSteps(runStep());

    await expect(checkPageFailureBudgetStep({
      step: tracker.step,
      name: "check production page failure budget",
      config: {},
      budgeted: { failedPages: [failed("a")], plannedCount: 5 },
    })).resolves.toBeUndefined();
  });
});
