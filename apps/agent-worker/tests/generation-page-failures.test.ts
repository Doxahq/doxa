import { describe, expect, test, vi } from "vitest";
import { GENERATION_PAGE_FLAGGED_EVENT_TYPE as PAGE_FLAGGED_EVENT_TYPE } from "@doxahq/contracts/generation-reviews";
import {
  assertPageFailureBudget,
  collectPageBatchOutcomes,
  isPageFailureBudgetExceeded,
  isRunStoppingError,
  pageTitlesFromStructure,
  planWithFailedPages,
  recordFlaggedPages,
} from "../src/generation-page-failures";

const failed = (id: string, reason = "Overloaded") => ({ id, title: `Title ${id}`, reason });

describe("page failure budget", () => {
  test("a run fails only at 80% failed pages or more", () => {
    expect(isPageFailureBudgetExceeded(7, 10)).toBe(false);
    expect(isPageFailureBudgetExceeded(8, 10)).toBe(true);
    expect(isPageFailureBudgetExceeded(42, 51)).toBe(true);
    expect(isPageFailureBudgetExceeded(9, 51)).toBe(false);
    expect(isPageFailureBudgetExceeded(0, 0)).toBe(false);
  });

  test("the failure names the count and the first reasons", () => {
    expect(() => assertPageFailureBudget([failed("a"), failed("b")], 2)).toThrow(
      "2 of 2 pages could not be written, so the run stopped instead of publishing an incomplete site. Title a: Overloaded; Title b: Overloaded",
    );
    expect(() => assertPageFailureBudget([failed("a")], 2)).not.toThrow();
  });
});

describe("batch outcomes", () => {
  test("joins written keys and failures, and fails every page of a failed batch", () => {
    const outcome = collectPageBatchOutcomes(
      [["a", "b"], ["c", "d"]],
      [
        { status: "fulfilled", value: { keys: ["key-a"], failedPages: [failed("b")] } },
        { status: "rejected", reason: new Error("internal error; reference = abc") },
      ],
      (pageId) => `Page ${pageId}`,
    );

    expect(outcome).toEqual({
      keys: ["key-a"],
      failedPages: [
        failed("b"),
        { id: "c", title: "Page c", reason: "internal error; reference = abc" },
        { id: "d", title: "Page d", reason: "internal error; reference = abc" },
      ],
    });
  });

  test("only a cancelled, paused or timed-out run stops all batches", () => {
    expect(isRunStoppingError(new Error("Generation job is no longer active."))).toBe(true);
    expect(isRunStoppingError(new Error("Generation is paused: maintenance"))).toBe(true);
    expect(isRunStoppingError(new Error("Generation exceeded its 180-minute overall budget."))).toBe(true);
    expect(isRunStoppingError(new Error("internal error; reference = abc"))).toBe(false);
    expect(isRunStoppingError(new Error("Model provider error (spend_cap): Your credit balance is too low"))).toBe(true);
    expect(isRunStoppingError(new Error("Model provider error (overloaded): Overloaded"))).toBe(false);
  });
});

describe("plan with failed pages", () => {
  const plan = {
    regeneratePageIds: ["docs/a", "docs/b", "docs/c"],
    reusePageIds: ["docs/d"],
    removedPageIds: [],
  };

  test("a failed page with a published version is reused; one without is left out", () => {
    const result = planWithFailedPages(
      plan,
      [failed("docs/b"), failed("docs/c")],
      new Set(["docs/b", "docs/d"]),
    );

    expect(result.plan).toEqual({
      regeneratePageIds: ["docs/a"],
      reusePageIds: ["docs/d", "docs/b"],
      removedPageIds: [],
    });
    expect([...result.leftOutPageIds]).toEqual(["docs/c"]);
    expect(result.flaggedPages.map((page) => [page.id, page.outcome])).toEqual([
      ["docs/b", "kept_published"],
      ["docs/c", "left_out"],
    ]);
  });

  test("no failure leaves the plan as it was", () => {
    expect(planWithFailedPages(plan, [], new Set()).plan).toEqual(plan);
  });
});

describe("flagged pages", () => {
  test("titles come from the structure checkpoint by stable page ID", () => {
    const titleOf = pageTitlesFromStructure(JSON.stringify({
      sections: [{ id: "documentation", pages: [{ id: "install", title: "Install" }] }],
    }));
    expect(titleOf("documentation/install")).toBe("Install");
    expect(titleOf("documentation/missing")).toBe("documentation/missing");
    expect(pageTitlesFromStructure("not json")("a/b")).toBe("a/b");
  });

  test("records one job event per flagged page, with the route of a kept page", async () => {
    const addJobEvent = vi.fn(async (_event: { type: string }) => undefined);
    await recordFlaggedPages({
      flaggedPages: [
        { ...failed("docs/b"), outcome: "kept_published" },
        { ...failed("docs/c"), outcome: "left_out" },
      ],
      routeOf: (pageId) => (pageId === "docs/b" ? "/b" : "/c"),
      addJobEvent,
    });

    expect(addJobEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        type: PAGE_FLAGGED_EVENT_TYPE,
        message: "Title docs/b could not be rewritten and keeps its published version.",
        source: "worker",
        data: { pageId: "docs/b", title: "Title docs/b", reason: "Overloaded", outcome: "kept_published", href: "/b" },
      },
      {
        type: PAGE_FLAGGED_EVENT_TYPE,
        message: "Title docs/c could not be written and is not in this version.",
        source: "worker",
        data: { pageId: "docs/c", title: "Title docs/c", reason: "Overloaded", outcome: "left_out", href: null },
      },
    ]);
  });
});

describe("writer fallback model", () => {
  test("defaults to the planner model and is unset when it equals the writer", async () => {
    const { resolveGenerationModels, generationModelIds } = await import("../src/model-provider");
    const models = { plannerModel: "claude-sonnet-5-5", writerModel: "claude-haiku-5-5" };

    expect(resolveGenerationModels({}, models)).toEqual({ ...models, writerFallbackModel: "claude-sonnet-5-5" });
    expect(resolveGenerationModels({ DOXA_WRITER_FALLBACK_MODEL: "claude-opus-5-5" }, models).writerFallbackModel)
      .toBe("claude-opus-5-5");
    expect(resolveGenerationModels({}, { plannerModel: "m", writerModel: "m" })).toEqual({ plannerModel: "m", writerModel: "m" });
    // A caller passes the whole execution config; the container accepts only model fields.
    const { generationModelConfigSchema } = await import("@doxahq/contracts");
    const executionConfig = {
      ...models,
      generationProfile: "full-prod",
      planningFingerprint: "planning",
      writingFingerprint: "writing",
      generatorFingerprint: "generator",
    };
    const fromExecutionConfig = resolveGenerationModels({}, executionConfig);
    expect(generationModelConfigSchema.safeParse(fromExecutionConfig).success).toBe(true);
    expect(generationModelIds(resolveGenerationModels({}, models))).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
  });
});

describe("REST extraction model", () => {
  test("is never sent: a leftover DOXA_REST_EXTRACTION_MODEL setting adds no model to a run", async () => {
    const { resolveGenerationModels, generationModelIds } = await import("../src/model-provider");
    const models = { plannerModel: "m", writerModel: "m" };
    const env = { DOXA_WRITER_FALLBACK_MODEL: "m", DOXA_REST_EXTRACTION_MODEL: "claude-haiku-5-5" };

    const resolved = resolveGenerationModels(env, models);
    expect(resolved).toEqual(models);
    expect(generationModelIds(resolved)).toEqual(["m", "m"]);
  });
});
