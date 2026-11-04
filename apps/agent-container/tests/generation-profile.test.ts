import { describe, expect, test } from "vitest";
import { containerGenerateRequestSchema, type ContainerGenerateRequest } from "@doxahq/contracts";
import {
  StructureInfeasibleConstraintsError,
  type DocumentationStructure,
} from "@doxahq/agent";
import { classifyGenerationStageError } from "../src/generation-stage-errors";
import {
  applyGenerationProfileBudget,
  countStructurePages,
  HOSTED_DOCS_QUALITY,
  HOSTED_WRITER_MAX_STEPS,
  HOSTED_WRITER_VALIDATION,
  hostedDocsQualityFailureAction,
  hostedPageFailureAction,
  resolvedEditorialPageBudget,
  resolvedPageConcurrency,
  resolvedWriterExploration,
} from "../src/generation-profile";

describe("generation profile helpers", () => {
  test("keeps hosted source validation enabled through final generation", () => {
    expect(HOSTED_WRITER_VALIDATION).toEqual({
      maxAttempts: 3,
      mdxCompile: true,
      timeoutMs: 10_000,
      targetedRepairClasses: [
        "mdx",
        "frontmatter",
        "length",
      ],
    });
    expect(HOSTED_DOCS_QUALITY).toEqual({
      enabled: true,
      maxRepairAttempts: 3,
      maxRepairAttemptsPerPage: 2,
    });
  });

  test("caps hosted agentic writer turns at the agent default", () => {
    expect(HOSTED_WRITER_MAX_STEPS).toBe(8);
  });

  test("defaults writer exploration to evidence-first unless agentic is explicitly requested", () => {
    expect(resolvedWriterExploration({})).toBe("evidence_first");
    expect(resolvedWriterExploration({
      DOXA_WRITER_EXPLORATION: "evidence_first",
    })).toBe("evidence_first");
    expect(resolvedWriterExploration({
      DOXA_WRITER_EXPLORATION: "unsupported",
    })).toBe("evidence_first");
    expect(resolvedWriterExploration({
      DOXA_WRITER_EXPLORATION: "agentic",
    })).toBe("agentic");
  });

  test("retries a hosted page twice, then skips it instead of stopping the run", () => {
    expect(hostedPageFailureAction({ retryCount: 0 })).toBe("retry");
    expect(hostedPageFailureAction({ retryCount: 1 })).toBe("retry");
    expect(hostedPageFailureAction({ retryCount: 2 })).toBe("skip");
    expect(hostedPageFailureAction({ retryCount: 0, retryBudgetExhausted: true })).toBe("skip");
  });

  test("repairs a hosted quality failure until its budget is gone, then skips the page", () => {
    expect(hostedDocsQualityFailureAction({ retryCount: 1 })).toBe("retry");
    expect(hostedDocsQualityFailureAction({ retryCount: 2, retryBudgetExhausted: true })).toBe("skip");
  });

  test("uses fast MVP defaults when no explicit tuning is provided", () => {
    const input = validRequest({ generationProfile: "fast-mvp" });

    // The ceiling of the adaptive writer limiter, which starts at 8.
    expect(resolvedPageConcurrency(input)).toBe(24);
    expect(resolvedEditorialPageBudget(input)).toBe(24);
  });

  test("accepts the deprecated REST extraction model of an older worker", () => {
    const modelConfig = { plannerModel: "planner", writerModel: "writer", restExtractionModel: "extractor" };

    expect(containerGenerateRequestSchema.safeParse(validRequest({ modelConfig })).success).toBe(true);
  });

  test("takes the editorial budget from the profile and ignores the deprecated maxPages field", async () => {
    expect(resolvedEditorialPageBudget(validRequest({ generationProfile: "full-prod" }))).toBe(36);
    expect(resolvedEditorialPageBudget(
      validRequest({ generationProfile: "full-prod", maxPages: 4 }),
    )).toBe(36);

    const original = structureWithPages(24);
    const events: string[] = [];
    const result = await applyGenerationProfileBudget(
      validRequest({ generationProfile: "fast-mvp", maxPages: 4 }),
      original,
      async (type) => {
        events.push(type);
      },
    );

    expect(result).toBe(original);
    expect(countStructurePages(result)).toBe(24);
    expect(events).toEqual(["structure_budget_applied"]);
  });

  test("stops before writing when a reviewed structure exceeds the editorial budget", async () => {
    let failure: unknown;
    try {
      await applyGenerationProfileBudget(
        validRequest({ generationProfile: "full-prod" }),
        structureWithPages(37),
        async () => {},
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(StructureInfeasibleConstraintsError);
    expect(classifyGenerationStageError(failure)).toEqual({
      message:
        "The documentation plan could not be reduced from 37 editorial pages " +
        "to the editorial limit of 36. " +
        "Generation stopped before writing incomplete documentation.",
      retryable: false,
      code: "structure_infeasible_constraints",
    });
  });

  test("keeps every reference page above the editorial budget, with no total page cap", async () => {
    const structure = structureWithReferenceAndProsePages(3_762, 36);

    await expect(applyGenerationProfileBudget(
      validRequest({ generationProfile: "full-prod" }),
      structure,
      async () => {},
    )).resolves.toBe(structure);
    expect(countStructurePages(structure)).toBe(3_798);
  });

  test("continues with a review-degraded structure while retaining the editorial budget", async () => {
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const structure = structureWithPages(37);

    const result = await applyGenerationProfileBudget(
      validRequest({ generationProfile: "full-prod" }),
      structure,
      async (type, _message, data) => {
        events.push({ type, data });
      },
      { reviewDegraded: true },
    );

    expect(result).toBe(structure);
    expect(events).toEqual([{
      type: "structure_budget_applied",
      data: expect.objectContaining({
        editorialBudget: 36,
        reviewDegraded: true,
      }),
    }]);
  });
});

function validRequest(overrides: Partial<ContainerGenerateRequest>): ContainerGenerateRequest {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    repositoryFullName: "doxahq/doxa-demo",
    defaultBranch: "main",
    installationAccessToken: "install-token",
    modelProvider: "openrouter",
    modelApiKey: "openrouter-key",
    model: "x-ai/grok-4.5",
    generationProfile: "fast-mvp",
    siteId: "site-1",
    versionId: "version-1",
    projectSlug: "doxa-demo",
    projectName: "Doxa Demo",
    ...overrides,
  };
}

function structureWithPages(pageCount: number): DocumentationStructure {
  return {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          id: `page-${index + 1}`,
          title: `Page ${index + 1}`,
          description: `Page ${index + 1} description.`,
        })),
      },
    ],
  };
}

function structureWithReferenceAndProsePages(
  referencePageCount: number,
  prosePageCount: number,
): DocumentationStructure {
  return {
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        ...Array.from({ length: referencePageCount }, (_, index) => ({
          id: `endpoint-${index + 1}`,
          title: `Endpoint ${index + 1}`,
          description: `Use public endpoint ${index + 1} from the API reference.`,
          group: "API Reference",
          reference: { kind: "rest" as const, endpointId: `endpoint-${index + 1}` },
        })),
        ...Array.from({ length: prosePageCount }, (_, index) => ({
          id: `guide-${index + 1}`,
          title: `Guide ${index + 1}`,
          description: `Complete guide ${index + 1} for a distinct public workflow.`,
        })),
      ],
    }],
  };
}

describe("structure review telemetry", () => {
  test("reports the share of pages that the review merged, moved or dropped", async () => {
    const { reviewDecisionTelemetry } = await import("../src/staged-generation");
    expect(reviewDecisionTelemetry({ keepCount: 7, mergeCount: 1, moveCount: 1, dropCount: 1 }))
      .toEqual({ keepCount: 7, mergeCount: 1, moveCount: 1, dropCount: 1, changedShare: 0.3 });
    expect(reviewDecisionTelemetry({ keepCount: 0, mergeCount: 0, moveCount: 0, dropCount: 0 }).changedShare).toBe(0);
  });
});
