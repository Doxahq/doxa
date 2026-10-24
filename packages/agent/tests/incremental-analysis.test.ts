import {
  analyzeProjectOnly,
  documentationBriefFingerprint,
  MAX_STRUCTURE_PATCH_CHANGES,
  planRevisionAwareGeneration,
  resolveDocumentationBrief,
  type AgentCacheManager,
  type ChatRequest,
  type Provider,
  type PriorRevisionGenerationState,
  type RevisionSourceChange,
} from "../src";
import { incrementalGenerationPlanSchema } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import { analysisFixture } from "./fixtures";

const planningFingerprint = "planning-contract-v1";
const writingFingerprint = "writer-contract-v1:model-a";
const structuralFingerprint = "structure-v1";
const pageInputHashes = {
  overview: "overview-input",
  guide: "guide-input",
};

describe("revision-aware incremental generation", () => {
  test("uses zero model calls for documentation-neutral changes", () => {
    const plan = buildPlan([
      { path: "tests/client.test.ts", status: "modified" },
      { path: ".github/workflows/ci.yml", status: "modified" },
      { path: "pnpm-lock.yaml", status: "modified" },
    ]);

    expect(plan).toMatchObject({
      analysisMode: "reuse",
      structureMode: "reuse",
      regeneratePageIds: [],
      reusePageIds: ["overview", "guide"],
      modelCallsRequired: false,
    });
  });

  test("regenerates only a page with a changed dependency", () => {
    const plan = buildPlan([
      { path: "src/client.ts", status: "modified" },
    ]);

    expect(plan).toMatchObject({
      analysisMode: "incremental",
      structureMode: "reuse",
      regeneratePageIds: ["guide"],
      reusePageIds: ["overview"],
      modelCallsRequired: true,
      causes: {
        newPages: 0,
        inputChanged: 0,
        dependencyChanged: 1,
      },
    });
  });

  test("patches the published structure for a route change", () => {
    const plan = buildPlan([
      { path: "src/routes/users.ts", status: "modified" },
    ]);

    expect(plan).toMatchObject({
      analysisMode: "incremental",
      structureMode: "patch",
      regeneratePageIds: ["overview", "guide"],
      reusePageIds: [],
      modelCallsRequired: true,
    });
  });

  test("patches the published structure when a spec file of the REST reference changes", () => {
    const changes: RevisionSourceChange[] = [{ path: "contracts/shop.yaml", status: "modified" }];

    expect(buildPlan(changes).structureMode).not.toBe("patch");
    expect(buildPlan(changes, new Set(["contracts/shop.yaml"])).structureMode).toBe("patch");
  });

  test("patches for an edited package manifest and plans again for a new one", () => {
    expect(buildPlan([{ path: "packages/sdk/package.json", status: "modified" }]).structureMode).toBe("patch");
    expect(buildPlan([{ path: "packages/cli/package.json", status: "added" }]).structureMode).toBe("regenerate");
    expect(buildPlan([{ path: "packages/old/package.json", status: "deleted" }]).structureMode).toBe("regenerate");
  });

  test("plans the structure again for a docs configuration change or a very large change", () => {
    expect(buildPlan([{ path: "docs.config.ts", status: "modified" }]).structureMode).toBe("regenerate");
    const manyRoutes = Array.from({ length: MAX_STRUCTURE_PATCH_CHANGES + 1 }, (_, index) => ({
      path: `src/routes/resource-${index}.ts`,
      status: "modified" as const,
    }));
    expect(buildPlan(manyRoutes).structureMode).toBe("regenerate");
    expect(buildPlan(manyRoutes.slice(0, MAX_STRUCTURE_PATCH_CHANGES)).structureMode).toBe("patch");
  });

  test("reuses the published analysis for a structural fingerprint mismatch", () => {
    const previous = previousState();
    previous.structuralFingerprint = "structure-v0";

    const plan = planRevisionAwareGeneration({
      currentPageIds: ["overview", "guide"],
      currentPageInputHashes: pageInputHashes,
      changes: [{ path: "src/client.ts", status: "modified" }],
      planningFingerprint,
      writingFingerprint,
      structuralFingerprint,
      previous,
    });

    expect(plan).toMatchObject({
      analysisMode: "incremental",
      structureMode: "regenerate",
      regeneratePageIds: ["overview", "guide"],
      reusePageIds: [],
      modelCallsRequired: true,
    });
  });

  test("matches a deleted dependency", () => {
    const plan = buildPlan([
      { path: "src/client.ts", status: "deleted" },
    ]);

    expect(plan.regeneratePageIds).toEqual(["guide"]);
    expect(plan.reasons[0]).toContain("src/client.ts");
  });

  test("matches the previous path of a renamed dependency", () => {
    const plan = buildPlan([
      {
        path: "src/new-client.ts",
        previousPath: "src/client.ts",
        status: "renamed",
      },
    ]);

    expect(plan.regeneratePageIds).toEqual(["guide"]);
    expect(plan.reasons[0]).toContain("src/client.ts");
  });

  test("falls back globally when reusable state is missing", () => {
    const plan = planRevisionAwareGeneration({
      currentPageIds: ["overview", "guide"],
      currentPageInputHashes: pageInputHashes,
      changes: [],
      planningFingerprint,
      writingFingerprint,
      structuralFingerprint,
      previous: null,
    });

    expect(plan).toMatchObject({
      analysisMode: "full",
      structureMode: "regenerate",
      regeneratePageIds: ["overview", "guide"],
      modelCallsRequired: true,
    });
  });

  test("reuses analysis and structure while rewriting pages when only the writer changes", () => {
    const previous = previousState();
    previous.writingFingerprint = "writer-contract-v1:model-b";

    const plan = planRevisionAwareGeneration({
      currentPageIds: ["overview", "guide"],
      currentPageInputHashes: pageInputHashes,
      changes: [],
      planningFingerprint,
      writingFingerprint,
      structuralFingerprint,
      previous,
    });

    expect(plan).toMatchObject({
      analysisMode: "reuse",
      structureMode: "reuse",
      regeneratePageIds: ["overview", "guide"],
      reusePageIds: [],
      modelCallsRequired: true,
    });
    expect(plan.reasons).toEqual([
      "The writer contract changed; existing analysis and structure remain reusable.",
    ]);
  });

  test("regenerates planning only when its model-independent contract changes", () => {
    const previous = previousState();
    previous.planningFingerprint = "planning-contract-v0";

    const plan = planRevisionAwareGeneration({
      currentPageIds: ["overview", "guide"],
      currentPageInputHashes: pageInputHashes,
      changes: [],
      planningFingerprint,
      writingFingerprint,
      structuralFingerprint,
      previous,
    });

    expect(plan.reasons).toEqual([
      "The documentation planning contract changed.",
    ]);
    expect(plan.regeneratePageIds).toEqual(["overview", "guide"]);
  });

  test("keeps legacy schema-compatible state reusable when stage fingerprints are absent", () => {
    const previous = previousState();
    delete previous.planningFingerprint;
    delete previous.writingFingerprint;

    expect(
      planRevisionAwareGeneration({
        currentPageIds: ["overview", "guide"],
        currentPageInputHashes: pageInputHashes,
        changes: [],
        planningFingerprint,
        writingFingerprint,
        structuralFingerprint,
        previous,
      }),
    ).toMatchObject({
      analysisMode: "reuse",
      structureMode: "reuse",
      regeneratePageIds: [],
      reusePageIds: ["overview", "guide"],
      modelCallsRequired: false,
    });
  });
});

describe("published analysis reuse", () => {
  test("uses one incremental model call without exploring when the brief matches", async () => {
    const requests: ChatRequest[] = [];
    let explorationCalls = 0;
    const provider: Provider = {
      config: {
        baseUrl: "https://example.invalid",
        apiKey: "test-key",
        model: "test-model",
      },
      async chat(request) {
        requests.push(request);
        return {
          message: {
            role: "assistant",
            content: JSON.stringify(analysisFixture),
          },
        };
      },
      async *chatStream() {
        explorationCalls += 1;
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: "unexpected exploration",
          },
        };
      },
    };
    const briefFingerprint = documentationBriefFingerprint(
      resolveDocumentationBrief(undefined),
    );
    const cacheManager = incrementalAnalysisCache(briefFingerprint);

    const analysis = await analyzeProjectOnly(
      {
        cwd: process.cwd(),
        toolPolicy: "read_only",
        provider,
      },
      undefined,
      cacheManager,
    );

    expect(analysis.projectName).toBe(analysisFixture.projectName);
    expect(requests).toHaveLength(1);
    expect(explorationCalls).toBe(0);
  });
});

function buildPlan(changes: RevisionSourceChange[], structuralPaths?: ReadonlySet<string>) {
  return planRevisionAwareGeneration({
    currentPageIds: ["overview", "guide"],
    currentPageInputHashes: pageInputHashes,
    changes,
    planningFingerprint,
    writingFingerprint,
    structuralFingerprint,
    previous: previousState(),
    structuralPaths,
  });
}

describe("pages with new inputs and no source change", () => {
  test("writes again only the pages whose input hash changed, such as template pages after a new template version", () => {
    const plan = planRevisionAwareGeneration({
      currentPageIds: ["overview", "guide"],
      currentPageInputHashes: { ...pageInputHashes, guide: "guide-input-template-v4" },
      changes: [],
      planningFingerprint,
      writingFingerprint,
      structuralFingerprint,
      previous: previousState(),
      templatePageIds: new Set(["guide"]),
    });

    expect(plan).toMatchObject({
      analysisMode: "reuse",
      structureMode: "reuse",
      regeneratePageIds: ["guide"],
      reusePageIds: ["overview"],
      modelCallsRequired: true,
    });
    expect(incrementalGenerationPlanSchema.safeParse(plan).success).toBe(true);
  });

  test("reuses every page when no source and no page input changed", () => {
    expect(planRevisionAwareGeneration({
      currentPageIds: ["overview", "guide"],
      currentPageInputHashes: pageInputHashes,
      changes: [],
      planningFingerprint,
      writingFingerprint,
      structuralFingerprint,
      previous: previousState(),
    })).toMatchObject({ regeneratePageIds: [], reusePageIds: ["overview", "guide"], modelCallsRequired: false });
  });
});

function previousState(): PriorRevisionGenerationState {
  return {
    planningFingerprint,
    writingFingerprint,
    structuralFingerprint,
    pages: [
      {
        pageId: "overview",
        pageInputHash: pageInputHashes.overview,
        dependencies: dependencies(["README.md"]),
      },
      {
        pageId: "guide",
        pageInputHash: pageInputHashes.guide,
        dependencies: dependencies(["src/client.ts"]),
      },
    ],
  };
}

function dependencies(sourceFilesRead: string[]) {
  return {
    sourceFilesRead,
    sourceFilesDiscovered: [],
    sourceEvidenceFiles: [],
    referencedSymbols: [],
    referencedRoutes: [],
  };
}

function incrementalAnalysisCache(
  briefFingerprint: string,
): AgentCacheManager {
  return {
    async checkAnalysis() {
      return {
        needsReanalysis: true,
        cachedAnalysis: {
          ...analysisFixture,
          __doxaDocumentationBriefFingerprint: briefFingerprint,
        },
        cachedExplorationContext: "published analysis",
        currentCommitHash: "a".repeat(40),
        changedFiles: ["src/index.ts"],
        addedFiles: [],
        deletedFiles: [],
      };
    },
    async saveAnalysis() {},
    async checkDocs() {
      throw new Error("Unexpected docs cache read.");
    },
    async saveDocs() {
      throw new Error("Unexpected docs cache write.");
    },
    async updateDocPages() {
      throw new Error("Unexpected docs cache update.");
    },
  };
}
