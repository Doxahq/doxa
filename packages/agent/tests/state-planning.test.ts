import { describe, expect, test } from "vitest";
import {
  buildAnalysisHash,
  buildPageInputHashes,
  planPagesAgainstBaseline,
  planDocsGeneration,
  type DocsManifest,
  type PriorRevisionGenerationState,
} from "../src";
import { flattenStructure } from "../src/state/page-targets";
import { structureFixture } from "./fixtures";

describe("incremental docs planning", () => {
  test("invalidates analysis identity when project-wide guidance changes", async () => {
    const first = await buildAnalysisHash({
      projectName: "Fixture",
      projectType: "library",
      languages: [], frameworks: [], entryPoints: [], keyFiles: [],
      summary: "Fixture", projectDescription: "Fixture", projectCategory: "library",
      isMonorepo: false, hasReact: false, hasApiRoutes: false, hasCli: false,
      packages: [], cliCommands: [], configFiles: [], apiEndpoints: [], keyFeatures: [],
      installMethods: [], externalIntegrations: [],
    }, { target: { kind: "public" }, projectContext: "Focus on SDK adopters." });
    const second = await buildAnalysisHash({
      projectName: "Fixture",
      projectType: "library",
      languages: [], frameworks: [], entryPoints: [], keyFiles: [],
      summary: "Fixture", projectDescription: "Fixture", projectCategory: "library",
      isMonorepo: false, hasReact: false, hasApiRoutes: false, hasCli: false,
      packages: [], cliCommands: [], configFiles: [], apiEndpoints: [], keyFeatures: [],
      installMethods: [], externalIntegrations: [],
    }, { target: { kind: "public" }, projectContext: "Focus on CLI users." });

    expect(first).not.toBe(second);
  });

  test("regenerates changed dependency pages, changed input pages, and new pages", async () => {
    const targets = flattenStructure(structureFixture);
    const hashes = await buildPageInputHashes(targets);
    const previousManifest: DocsManifest = {
      pages: [
        {
          pageId: "overview",
          outputPath: "default/overview/index.mdx",
          title: "Overview",
          sectionTitle: "Documentation",
          dependencies: dependencies(["src/index.ts"]),
          contentHash: "old",
          pageInputHash: hashes.overview,
          generatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          pageId: "guides",
          outputPath: "default/guides/index.mdx",
          title: "Guides",
          sectionTitle: "Documentation",
          dependencies: dependencies(["src/guides.ts"]),
          contentHash: "old",
          pageInputHash: "stale-input",
          generatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      structureHash: "structure",
      analysisHash: "analysis-a",
      generatedAt: "2026-01-01T00:00:00.000Z",
    };

    const plan = planDocsGeneration({
      allPageIds: targets.map((target) => target.pageId),
      pageInputHashes: hashes,
      previousManifest,
      sourceChanges: {
        changedFiles: ["src/index.ts"],
        addedFiles: [],
        deletedFiles: [],
      },
      currentAnalysisHash: "analysis-a",
    });

    expect(plan.pagesToGenerate.sort()).toEqual([
      "guides",
      "guides/install",
      "overview",
    ]);
    expect(plan.reasons.overview).toContain("src/index.ts");
    expect(plan.reasons.guides).toBe("Page inputs changed");
    expect(plan.reasons["guides/install"]).toBe("New page");
  });
});

describe("post-structure page planning", () => {
  test("regenerates a page that is new in the current structure", () => {
    const plan = planPagesAgainstBaseline({
      currentPageIds: ["overview", "new-page"],
      currentPageInputHashes: {
        overview: "overview-hash",
        "new-page": "new-page-hash",
      },
      dependencyChangePaths: new Set(),
      previous: priorRevision([
        priorPage("overview", "overview-hash"),
      ]),
    });

    expect(plan).toMatchObject({
      regeneratePageIds: ["new-page"],
      reusePageIds: ["overview"],
      removedPageIds: [],
      causes: {
        newPages: 1,
        inputChanged: 0,
        dependencyChanged: 0,
      },
    });
    expect(plan.reasons).toContain("Page new-page is new.");
    expect(causeTotal(plan.causes)).toBe(plan.regeneratePageIds.length);
  });

  test("regenerates a page whose post-structure input hash changed", () => {
    const plan = planPagesAgainstBaseline({
      currentPageIds: ["overview"],
      currentPageInputHashes: { overview: "new-hash" },
      dependencyChangePaths: new Set(),
      previous: priorRevision([
        priorPage("overview", "old-hash"),
      ]),
    });

    expect(plan.regeneratePageIds).toEqual(["overview"]);
    expect(plan.reusePageIds).toEqual([]);
    expect(plan.causes).toEqual({
      newPages: 0,
      inputChanged: 1,
      dependencyChanged: 0,
    });
    expect(plan.reasons).toContain("Page overview inputs changed.");
    expect(causeTotal(plan.causes)).toBe(plan.regeneratePageIds.length);
  });

  test("rewrites a template page only when its input hash changes, whatever its source files", () => {
    const plan = planPagesAgainstBaseline({
      currentPageIds: ["api/get-order", "api/list-orders", "guides/orders"],
      currentPageInputHashes: {
        "api/get-order": "get-order-hash",
        "api/list-orders": "list-orders-new-hash",
        "guides/orders": "guide-hash",
      },
      dependencyChangePaths: new Set(["openapi.yaml"]),
      previous: priorRevision([
        priorPage("api/get-order", "get-order-hash", ["openapi.yaml"]),
        priorPage("api/list-orders", "list-orders-old-hash", ["openapi.yaml"]),
        priorPage("guides/orders", "guide-hash", ["openapi.yaml"]),
      ]),
      templatePageIds: new Set(["api/get-order", "api/list-orders"]),
    });

    expect(plan.regeneratePageIds).toEqual(["api/list-orders", "guides/orders"]);
    expect(plan.reusePageIds).toEqual(["api/get-order"]);
    expect(plan.causes).toEqual({ newPages: 0, inputChanged: 1, dependencyChanged: 1 });
  });

  test("regenerates only pages depending on a changed source path", () => {
    const plan = planPagesAgainstBaseline({
      currentPageIds: ["overview", "configuration"],
      currentPageInputHashes: {
        overview: "overview-hash",
        configuration: "configuration-hash",
      },
      dependencyChangePaths: new Set(["src/config.ts"]),
      previous: priorRevision([
        priorPage("overview", "overview-hash", ["src/index.ts"]),
        priorPage("configuration", "configuration-hash", ["src/config.ts"]),
      ]),
    });

    expect(plan.regeneratePageIds).toEqual(["configuration"]);
    expect(plan.reusePageIds).toEqual(["overview"]);
    expect(plan.causes).toEqual({
      newPages: 0,
      inputChanged: 0,
      dependencyChanged: 1,
    });
    expect(plan.reasons).toContain(
      "Page configuration depends on changed source: src/config.ts.",
    );
    expect(causeTotal(plan.causes)).toBe(plan.regeneratePageIds.length);
  });

  test("reuses every clean page", () => {
    const plan = planPagesAgainstBaseline({
      currentPageIds: ["overview", "configuration"],
      currentPageInputHashes: {
        overview: "overview-hash",
        configuration: "configuration-hash",
      },
      dependencyChangePaths: new Set(),
      previous: priorRevision([
        priorPage("overview", "overview-hash"),
        priorPage("configuration", "configuration-hash"),
      ]),
    });

    expect(plan.regeneratePageIds).toEqual([]);
    expect(plan.reusePageIds).toEqual(["overview", "configuration"]);
    expect(plan.causes).toEqual({
      newPages: 0,
      inputChanged: 0,
      dependencyChanged: 0,
    });
    expect(plan.reasons).toEqual([
      "All current pages match the published page inputs and dependencies.",
    ]);
  });

  test("reports pages removed by the regenerated structure", () => {
    const plan = planPagesAgainstBaseline({
      currentPageIds: ["overview"],
      currentPageInputHashes: { overview: "overview-hash" },
      dependencyChangePaths: new Set(),
      previous: priorRevision([
        priorPage("overview", "overview-hash"),
        priorPage("removed", "removed-hash"),
      ]),
    });

    expect(plan.regeneratePageIds).toEqual([]);
    expect(plan.reusePageIds).toEqual(["overview"]);
    expect(plan.removedPageIds).toEqual(["removed"]);
  });
});

function dependencies(sourceFilesRead: string[]) {
  return {
    sourceFilesRead,
    sourceFilesDiscovered: [],
    sourceEvidenceFiles: [],
    referencedSymbols: [],
    referencedRoutes: [],
  };
}

function causeTotal(causes: {
  newPages: number;
  inputChanged: number;
  dependencyChanged: number;
}): number {
  return causes.newPages + causes.inputChanged + causes.dependencyChanged;
}

function priorRevision(
  pages: PriorRevisionGenerationState["pages"],
): PriorRevisionGenerationState {
  return {
    planningFingerprint: "planning-v1",
    writingFingerprint: "writing-v1",
    structuralFingerprint: "structural-v1",
    pages,
  };
}

function priorPage(
  pageId: string,
  pageInputHash: string,
  sourceFilesRead: string[] = [],
): PriorRevisionGenerationState["pages"][number] {
  return {
    pageId,
    pageInputHash,
    dependencies: dependencies(sourceFilesRead),
  };
}
