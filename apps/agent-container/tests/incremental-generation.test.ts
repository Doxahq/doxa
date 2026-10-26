import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeProjectOnly,
  buildPageInputHashMap,
  buildStructuralFingerprint,
  documentationBriefFingerprint,
  hashObject,
  resolveDocumentationBrief,
  type AgentConfig,
  type DocumentationStructure,
  type ProjectAnalysis,
} from "@doxahq/agent";
import {
  GENERATION_STATE_SCHEMA_VERSION,
  toJsonValue,
  type GenerationSourceState,
  type RepositorySnapshot,
  type ReusableGenerationState,
  incrementalGenerationPlanSchema,
} from "@doxahq/contracts";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  analyzeIncrementalGeneration,
  finalizeIncrementalPlan,
} from "../src/incremental-generation";
import { resolveSnapshotSourceDelta } from "../src/source-delta";

vi.mock("@doxahq/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@doxahq/agent")>();
  return {
    ...actual,
    analyzeProjectOnly: vi.fn(),
  };
});

const targetRevision = "a".repeat(40);
const sourceTreeHash = "b".repeat(40);
const config: AgentConfig = {
  cwd: "/tmp/doxa-checkout",
  toolPolicy: "read_only",
};
const snapshot: RepositorySnapshot = {
  targetRevision,
  sourceTreeHash,
  changes: [],
};
const sourceState: GenerationSourceState = {
  schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
  sourceRevision: targetRevision,
  sourceTreeHash,
  files: [],
};

describe("incremental generation checkpoints", () => {
  beforeEach(() => {
    vi.mocked(analyzeProjectOnly).mockReset();
  });

  test("canonicalizes optional analysis fields before validating persistent state", async () => {
    const analysis = flagForgeAnalysisWithUndefinedFields();
    vi.mocked(analyzeProjectOnly).mockResolvedValue(analysis);

    const result = await analyzeIncrementalGeneration({
      config,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      snapshot,
      sourceState,
    });

    expect(result.analysis).toBe(analysis);
    const persistentAnalysis = {
      projectName: "FlagForge",
      configFiles: [
        {
          path: "vite.config.ts",
          description: "Vite configuration",
        },
      ],
      documentationCollections: [
        {
          id: "packages",
          title: "Packages",
          kind: "package",
          sourceEvidence: [{ path: "package.json" }],
          items: [
            {
              id: "sdk",
              title: "SDK",
              slug: "sdk",
              sourceEvidence: [{ path: "packages/sdk/src/index.ts" }],
            },
          ],
        },
      ],
    };
    expect(result.analysisState.analysis).toEqual(persistentAnalysis);
    expect(result.analysisState.analysisHash).toBe(
      hashObject(persistentAnalysis),
    );
    expect(result.analysisState).toHaveProperty(
      "documentationBriefFingerprint",
      documentationBriefFingerprint(
        resolveDocumentationBrief(config.documentationBrief),
      ),
    );
    expect(
      Object.keys(result.analysisState.analysis as Record<string, unknown>),
    ).not.toContainEqual(expect.stringMatching(/^__doxa/));
  });

  test.each([
    ["a spec name that only discovery knows", "spec/petstore.yaml"],
    ["a known spec name outside an api folder", "services/orders.openapi.json"],
  ])("treats a new spec under %s as structural, so its endpoints get pages", async (_label, path) => {
    const checkoutRoot = await mkdtemp(join(tmpdir(), "doxa-spec-structural-"));
    try {
      await mkdir(dirname(join(checkoutRoot, path)), { recursive: true });
      await writeFile(join(checkoutRoot, path), path.endsWith(".json") ? '{"openapi":"3.1.0","paths":{}}' : "openapi: 3.1.0\npaths: {}\n");
      const reusableState = reusableStateWithPages(structureWithPages(3));
      reusableState.structure.structuralFingerprint = await buildStructuralFingerprint(sourceState.files);
      vi.mocked(analyzeProjectOnly).mockResolvedValue(flagForgeAnalysisWithUndefinedFields());

      const result = await analyzeIncrementalGeneration({
        config: { ...config, cwd: checkoutRoot },
        planningFingerprint: "planning-v1",
        writingFingerprint: "writing-v1",
        reusableState,
        snapshot: { targetRevision, sourceTreeHash, changes: [{ path, status: "added" }] },
        sourceState,
      });

      expect(result.preliminaryPlan.structureMode).not.toBe("reuse");
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true });
    }
  });

  test("round-trips the published brief fingerprint through the analysis cache only", async () => {
    const storedFingerprint = "published-brief-fingerprint";
    const reusableState = reusableStateWithPages(structureWithPages(3));
    Object.assign(reusableState.analysis, {
      documentationBriefFingerprint: storedFingerprint,
    });
    reusableState.structure.structuralFingerprint =
      await buildStructuralFingerprint(sourceState.files);
    reusableState.pages[2]!.dependencies.sourceFilesRead = ["src/client.ts"];
    const cachedAnalyses: Record<string, unknown>[] = [];
    vi.mocked(analyzeProjectOnly).mockImplementation(
      async (_config, _onProgress, cacheManager) => {
        const cacheCheck = await cacheManager!.checkAnalysis();
        cachedAnalyses.push(cacheCheck.cachedAnalysis ?? {});
        return flagForgeAnalysisWithUndefinedFields();
      },
    );

    await analyzeIncrementalGeneration({
      config,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: sourceChangeSnapshot("src/client.ts"),
      sourceState,
    });

    expect(cachedAnalyses).toEqual([
      {
        projectName: "FlagForge",
        __doxaDocumentationBriefFingerprint: storedFingerprint,
      },
    ]);
    expect(reusableState.analysis.analysis).toEqual({
      projectName: "FlagForge",
    });
  });

  test("keeps legacy published analysis safely fingerprint-free", async () => {
    const reusableState = reusableStateWithPages(structureWithPages(3));
    reusableState.structure.structuralFingerprint =
      await buildStructuralFingerprint(sourceState.files);
    reusableState.pages[2]!.dependencies.sourceFilesRead = ["src/client.ts"];
    let cachedAnalysis: Record<string, unknown> | null = null;
    vi.mocked(analyzeProjectOnly).mockImplementation(
      async (_config, _onProgress, cacheManager) => {
        cachedAnalysis = (await cacheManager!.checkAnalysis()).cachedAnalysis;
        return flagForgeAnalysisWithUndefinedFields();
      },
    );

    await analyzeIncrementalGeneration({
      config,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: sourceChangeSnapshot("src/client.ts"),
      sourceState,
    });

    expect(cachedAnalysis).toEqual({ projectName: "FlagForge" });
  });

  test("reuses every published page when no source file changed", async () => {
    const reusableState = reusableStateWithPages(structureWithPages(3), false);
    reusableState.structure.structuralFingerprint =
      await buildStructuralFingerprint(sourceState.files);
    vi.mocked(analyzeProjectOnly).mockResolvedValue(
      flagForgeAnalysisWithUndefinedFields(),
    );

    const result = await analyzeIncrementalGeneration({
      config,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot,
      sourceState,
    });

    expect(result.preliminaryPlan.regeneratePageIds).toEqual([]);
    expect(result.preliminaryPlan.reusePageIds).toEqual([
      "guide/page-1",
      "guide/page-2",
      "guide/page-3",
    ]);
    expect(result.preliminaryPlan.removedPageIds).toEqual([]);
    expect(result.preliminaryPlan.modelCallsRequired).toBe(false);
  });

  test("plans a baseline that repeats one page ID across sections", async () => {
    const structure = structureWithRepeatedPageId();
    const reusableState = reusableStateForStructure(structure);
    reusableState.structure.structuralFingerprint =
      await buildStructuralFingerprint(sourceState.files);
    vi.mocked(analyzeProjectOnly).mockResolvedValue(
      flagForgeAnalysisWithUndefinedFields(),
    );

    const result = await analyzeIncrementalGeneration({
      config,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot,
      sourceState,
    });

    expect(result.preliminaryPlan.reusePageIds).toEqual([
      "guide/segments",
      "reference/segments",
    ]);
    expect(result.preliminaryPlan.regeneratePageIds).toEqual([]);
    expect(result.preliminaryPlan.modelCallsRequired).toBe(false);
  });

  test("reuses an unchanged baseline REST endpoint page", async () => {
    const structure = structureWithRestEndpointPage();
    const reusableState = reusableStateForStructure(structure);
    reusableState.structure.structuralFingerprint =
      await buildStructuralFingerprint(sourceState.files);
    vi.mocked(analyzeProjectOnly).mockResolvedValue(
      flagForgeAnalysisWithUndefinedFields(),
    );

    const result = await analyzeIncrementalGeneration({
      config,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot,
      sourceState,
    });

    expect(result.preliminaryPlan.reusePageIds).toEqual([
      "guide/rollouts",
      "reference/create-flag",
    ]);
    expect(result.preliminaryPlan.regeneratePageIds).toEqual([]);
    expect(result.preliminaryPlan.modelCallsRequired).toBe(false);
  });

  test("rewrites a REST endpoint page whose baseline the model writer stored", async () => {
    const structure = structureWithRestEndpointPage();
    const reusableState = reusableStateForStructure(structure);
    reusableState.pages = reusableState.pages.map((page) =>
      page.pageId === "reference/create-flag"
        ? { ...page, pageInputHash: "model-writer-page-input-hash" }
        : page
    );

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot,
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(
        Object.keys(buildPageInputHashMap(structure)),
      ),
    });

    expect(result.plan.regeneratePageIds).toEqual(["reference/create-flag"]);
    expect(result.plan.reusePageIds).toEqual(["guide/rollouts"]);
    expect(result.plan.causes).toMatchObject({ inputChanged: 1 });
  });

  test("after an instructions change, kept pages are edited from their published text", async () => {
    const published = structureWithPages(3);
    const reusableState = reusableStateWithPages(published);
    const replanned: DocumentationStructure = {
      sections: [{
        ...published.sections[0]!,
        pages: [...published.sections[0]!.pages, { id: "competitors", title: "Competitors", description: "Competitors", sourceEvidence: [] }],
      }],
    };
    const replannedIds = Object.keys(buildPageInputHashMap(replanned));

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot,
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure: replanned,
      preliminaryPlan: { ...preliminaryRegenerationPlan(replannedIds), editReason: "instructions_changed" },
    });

    const keptIds = reusableState.pages.map((page) => page.pageId);
    expect(result.plan.editReason).toBe("instructions_changed");
    expect(result.plan.regeneratePageIds).toEqual(replannedIds);
    expect(result.plan.reusePageIds).toEqual([]);
    expect(Object.keys(result.plan.pageEdits ?? {}).sort()).toEqual([...keptIds].sort());
    for (const pageId of keptIds) {
      expect(result.plan.pageEdits?.[pageId]).toMatchObject({ instructionsChanged: true });
    }
    expect(result.plan.pageEdits?.["guide/competitors"]).toBeUndefined();
    expect(incrementalGenerationPlanSchema.parse(result.plan)).toEqual(result.plan);
  });

  test("a plan that rewrites every page for another reason edits nothing", async () => {
    const published = structureWithPages(2);
    const reusableState = reusableStateWithPages(published);

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot,
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure: published,
      preliminaryPlan: preliminaryRegenerationPlan(Object.keys(buildPageInputHashMap(published))),
    });

    expect(result.plan.editReason).toBeUndefined();
    expect(Object.values(result.plan.pageEdits ?? {}).some((edit) => edit.instructionsChanged)).toBe(false);
  });

  test("canonicalizes optional structure fields before validating persistent state", async () => {
    const structure: DocumentationStructure = {
      sections: [
        {
          id: "guide",
          title: "Guide",
          default: true,
          pages: [
            {
              id: "overview",
              title: "Overview",
              description: "FlagForge overview",
              sourceEvidence: [
                {
                  path: "README.md",
                  kind: undefined,
                  title: undefined,
                },
              ],
            },
          ],
        },
      ],
    };

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      snapshot,
      structuralFingerprint: "c".repeat(64),
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(["overview"]),
    });

    const persistentStructure = {
      sections: [
        {
          id: "guide",
          title: "Guide",
          default: true,
          pages: [
            {
              id: "overview",
              title: "Overview",
              description: "FlagForge overview",
              sourceEvidence: [{ path: "README.md" }],
            },
          ],
        },
      ],
    };
    expect(result.structureState.structure).toEqual(persistentStructure);
    expect(result.structureState.structureHash).toBe(
      hashObject(persistentStructure),
    );
  });

  test("uses an empty source delta when the preview tree is unchanged", () => {
    const unchangedTree = "c".repeat(40);
    const current = sourceStateWithFiles(unchangedTree, [
      sourceFile("src/index.ts", "1"),
    ]);
    const previous = sourceStateWithFiles(unchangedTree, [
      sourceFile("src/index.ts", "1"),
    ]);

    expect(
      resolveSnapshotSourceDelta({
        snapshot: {
          ...snapshot,
          sourceTreeHash: unchangedTree,
          changes: [
            {
              path: "src/index.ts",
              status: "modified",
            },
          ],
        },
        current,
        previous,
      }).changes,
    ).toEqual([]);
  });

  test("calculates source changes from the preceding preview source state", () => {
    const previous = sourceStateWithFiles("c".repeat(40), [
      sourceFile("src/deleted.ts", "1"),
      sourceFile("src/index.ts", "2"),
      sourceFile("src/old-name.ts", "3"),
      sourceFile("src/stable.ts", "4"),
    ]);
    const current = sourceStateWithFiles("d".repeat(40), [
      sourceFile("src/added.ts", "5"),
      sourceFile("src/index.ts", "6"),
      sourceFile("src/new-name.ts", "3"),
      sourceFile("src/stable.ts", "4"),
    ]);

    expect(
      resolveSnapshotSourceDelta({
        snapshot: {
          ...snapshot,
          sourceTreeHash: current.sourceTreeHash,
          changes: [],
        },
        current,
        previous,
      }).changes,
    ).toEqual([
      {
        path: "src/added.ts",
        status: "added",
      },
      {
        path: "src/deleted.ts",
        status: "deleted",
      },
      {
        path: "src/index.ts",
        status: "modified",
      },
      {
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        status: "renamed",
      },
    ]);
  });

  test("keeps the exact Git delta without a preceding preview source state", () => {
    expect(
      resolveSnapshotSourceDelta({
        snapshot: {
          ...snapshot,
          changes: [
            {
              path: "src/index.ts",
              status: "modified",
            },
          ],
        },
        current: sourceState,
      }).changes,
    ).toEqual([
      {
        path: "src/index.ts",
        status: "modified",
      },
    ]);
  });

  test("makes zero model calls when the preceding preview tree matches", async () => {
    const reusableState = reusableStateFor(sourceState);
    const resolvedSnapshot = resolveSnapshotSourceDelta({
      snapshot,
      current: sourceState,
      previous: reusableState.source,
    });

    const result = await analyzeIncrementalGeneration({
      config,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: resolvedSnapshot,
      sourceState,
    });

    expect(result.preliminaryPlan).toMatchObject({
      analysisMode: "reuse",
      structureMode: "reuse",
      modelCallsRequired: false,
      regeneratePageIds: [],
    });
    expect(analyzeProjectOnly).not.toHaveBeenCalled();
  });

  test("diffs pages after structure regeneration instead of preserving the full-plan verdict", async () => {
    const structure = structureWithPages(10);
    const reusableState = reusableStateWithPages(structure);
    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(
        Object.keys(buildPageInputHashMap(structure)),
      ),
    });

    expect(result.plan.regeneratePageIds).toEqual(["guide/page-3"]);
    expect(result.plan.reusePageIds).toHaveLength(9);
    expect(result.plan.structureMode).toBe("regenerate");
    expect(result.plan.causes).toEqual({
      newPages: 0,
      inputChanged: 0,
      dependencyChanged: 1,
    });
  });

  test("rewrites every page whose stored hash its baseline structure does not explain", async () => {
    const structure = structureWithPages(10);
    const reusableState = reusableStateWithPages(structure);
    // Written from other inputs, for example by another renderer.
    reusableState.pages = reusableState.pages.map((page) => ({ ...page, pageInputHash: "f".repeat(64) }));

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(Object.keys(buildPageInputHashMap(structure))),
    });

    expect(result.plan.regeneratePageIds).toHaveLength(10);
    expect(result.plan.causes?.inputChanged).toBe(10);
  });

  test("reuses a page whose new plan only relabels its evidence or reflows its description", async () => {
    const published = withEvidence(structureWithPages(4), (index) => [
      { path: "packages/core/src/types.ts", kind: "source", title: "Operator type" },
      { path: `docs/page-${index}.md`, kind: "docs" },
    ]);
    const replanned = withEvidence(structureWithPages(4), (index) => [
      { path: `docs/page-${index}.md` },
      { path: "packages/core/src/types.ts" },
      { path: "packages/core/src/types.ts" },
    ]);
    replanned.sections[0]!.pages[1]!.description = `  ${replanned.sections[0]!.pages[1]!.description.replace(/ /g, "\n  ")}  `;
    const reusableState = reusableStateWithPages(published);

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure: replanned,
      preliminaryPlan: preliminaryRegenerationPlan(Object.keys(buildPageInputHashMap(replanned))),
    });

    // Only the page that read the changed route is written again.
    expect(result.plan.regeneratePageIds).toEqual(["guide/page-3"]);
    expect(result.plan.causes).toEqual({ newPages: 0, inputChanged: 0, dependencyChanged: 1 });
  });

  test("writes only the new page after a patch, even when no page read the changed route", async () => {
    const published = structureWithPages(5);
    const patched: DocumentationStructure = {
      sections: [{
        ...published.sections[0]!,
        pages: [
          ...published.sections[0]!.pages,
          { id: "get-environment", title: "Get environment", description: "Read one environment of a project by its key." },
        ],
      }],
    };
    const reusableState = reusableStateWithPages(published, false);

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure: patched,
      preliminaryPlan: {
        ...preliminaryRegenerationPlan(Object.keys(buildPageInputHashMap(published))),
        analysisMode: "incremental",
        structureMode: "patch",
      },
    });

    expect(result.plan.structureMode).toBe("patch");
    expect(result.plan.regeneratePageIds).toEqual(["guide/get-environment"]);
    expect(result.plan.reusePageIds).toHaveLength(5);
  });

  test("tells the writer to edit the published page that read the changed route", async () => {
    const structure = structureWithPages(4);
    const reusableState = reusableStateWithPages(structure);

    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(Object.keys(buildPageInputHashMap(structure))),
    });

    expect(result.plan.pageEdits).toEqual({
      "guide/page-3": {
        artifactKey: "sites/site-1/pages/page-3.mdx",
        changedSources: ["apps/api/src/routes/flags.ts"],
      },
    });
  });

  test("keeps a planning-fingerprint mismatch as a full regeneration", async () => {
    const structure = structureWithPages(3);
    const reusableState = reusableStateWithPages(structure);
    reusableState.pages = reusableState.pages.map((page) => ({
      ...page,
      pageId: page.pageId.replace(/^guide\//, ""),
    }));
    reusableState.manifest.planningFingerprint =
      "doxabot-planning-v3:fast-mvp:120";
    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "doxabot-planning-v4:fast-mvp:120",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(
        Object.keys(buildPageInputHashMap(structure)),
      ),
    });

    expect(result.plan).toMatchObject({
      analysisMode: "full",
      structureMode: "regenerate",
      regeneratePageIds: ["guide/page-1", "guide/page-2", "guide/page-3"],
      reusePageIds: [],
      reasons: ["The documentation planning contract changed."],
    });
  });

  test("rewrites every page when the writing fingerprint changes after structure regeneration", async () => {
    const structure = structureWithPages(3);
    const reusableState = reusableStateWithPages(structure);
    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v2",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(
        Object.keys(buildPageInputHashMap(structure)),
      ),
    });

    expect(result.plan).toMatchObject({
      structureMode: "regenerate",
      regeneratePageIds: ["guide/page-1", "guide/page-2", "guide/page-3"],
      reusePageIds: [],
      reasons: [
        "The writer contract changed; the regenerated structure remains usable but every page must be rewritten.",
      ],
    });
  });

  test("reports a dropped page without including it in either active verdict", async () => {
    const previousStructure = structureWithPages(10);
    const currentStructure = structureWithPages(9);
    const reusableState = reusableStateWithPages(previousStructure);
    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure: currentStructure,
      preliminaryPlan: preliminaryRegenerationPlan(
        Object.keys(buildPageInputHashMap(previousStructure)),
      ),
    });

    expect(result.plan.removedPageIds).toEqual(["guide/page-10"]);
    expect(result.plan.regeneratePageIds).toEqual(["guide/page-3"]);
    expect(result.plan.reusePageIds).toHaveLength(8);
    expect(result.plan.regeneratePageIds).not.toContain("guide/page-10");
    expect(result.plan.reusePageIds).not.toContain("guide/page-10");
  });

  test("regenerates every page when relevant changes are absent from the dependency ledger", async () => {
    const structure = structureWithPages(3);
    const reusableState = reusableStateWithPages(structure, false);
    const result = await finalizeIncrementalPlan({
      analysis: flagForgeAnalysisWithUndefinedFields(),
      documentationBrief: undefined,
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      reusableState,
      snapshot: routeChangeSnapshot(),
      structuralFingerprint: reusableState.structure.structuralFingerprint,
      structure,
      preliminaryPlan: preliminaryRegenerationPlan(
        Object.keys(buildPageInputHashMap(structure)),
      ),
    });

    expect(result.plan.regeneratePageIds).toEqual([
      "guide/page-1",
      "guide/page-2",
      "guide/page-3",
    ]);
    expect(result.plan.reusePageIds).toEqual([]);
    expect(result.plan.reasons).toEqual([
      "Documentation-relevant source changes are not mapped to prior page dependencies.",
    ]);
  });
});

function preliminaryRegenerationPlan(pageIds: string[]) {
  return {
    analysisMode: "full" as const,
    structureMode: "regenerate" as const,
    regeneratePageIds: pageIds,
    reusePageIds: [],
    removedPageIds: [],
    modelCallsRequired: pageIds.length > 0,
    reasons: ["A structural source changed."],
  };
}

function withEvidence(
  structure: DocumentationStructure,
  evidence: (index: number) => NonNullable<DocumentationStructure["sections"][number]["pages"][number]["sourceEvidence"]>,
): DocumentationStructure {
  return {
    sections: structure.sections.map((section) => ({
      ...section,
      pages: section.pages.map((page, index) => ({ ...page, sourceEvidence: evidence(index + 1) })),
    })),
  };
}

function routeChangeSnapshot(): RepositorySnapshot {
  return {
    targetRevision,
    sourceTreeHash,
    changes: [
      {
        path: "apps/api/src/routes/flags.ts",
        status: "modified",
      },
    ],
  };
}

function sourceChangeSnapshot(path: string): RepositorySnapshot {
  return {
    targetRevision,
    sourceTreeHash,
    changes: [{ path, status: "modified" }],
  };
}

function structureWithRepeatedPageId(): DocumentationStructure {
  return {
    sections: [
      {
        id: "guide",
        title: "Guide",
        default: true,
        pages: [
          {
            id: "segments",
            title: "Segments",
            description: "Document the segment workflow for the guide section.",
          },
        ],
      },
      {
        id: "reference",
        title: "Reference",
        pages: [
          {
            id: "segments",
            title: "Segments API",
            description: "Document the segment endpoints of the public API.",
          },
        ],
      },
    ],
  };
}

function structureWithRestEndpointPage(): DocumentationStructure {
  return {
    sections: [
      {
        id: "guide",
        title: "Guide",
        default: true,
        pages: [
          {
            id: "rollouts",
            title: "Rollouts",
            description: "Roll out a feature flag to a share of users.",
          },
        ],
      },
      {
        id: "reference",
        title: "REST API",
        pages: [
          {
            id: "create-flag",
            title: "Create a flag",
            description: "Create a feature flag and return the stored flag record.",
            sourceEvidence: [{ path: "apps/api/src/routes/flags.ts" }],
            audience: "reference",
            reference: {
              kind: "rest",
              pageKind: "endpoint",
              groupId: "flags",
              endpointId: "create-flag",
              method: "POST",
              path: "/flags",
            },
          },
        ],
      },
    ],
  };
}

function reusableStateForStructure(
  structure: DocumentationStructure,
): ReusableGenerationState {
  const reusableState = reusableStateFor(sourceState);
  const hashes = buildPageInputHashMap(structure);
  reusableState.manifest.planningFingerprint = "planning-v1";
  reusableState.manifest.writingFingerprint = "writing-v1";
  reusableState.structure.structure = toJsonValue(structure);
  reusableState.pages = structure.sections.flatMap((section) =>
    section.pages.map((page) => {
      const pageId = `${section.id}/${page.id}`;
      return {
        schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
        pageId,
        title: page.title,
        route: `/${section.id}/${page.id}`,
        navigationPath: `${section.id}/${page.id}/index.mdx`,
        artifactKey: `sites/site-1/pages/${section.id}-${page.id}.mdx`,
        contentHash: "e".repeat(64),
        pageInputHash: hashes[pageId]!,
        dependencies: {
          sourceFilesRead: [],
          sourceFilesDiscovered: [],
          sourceEvidenceFiles: [],
          referencedSymbols: [],
          referencedRoutes: [],
        },
      };
    })
  );
  return reusableState;
}

function structureWithPages(pageCount: number): DocumentationStructure {
  return {
    sections: [
      {
        id: "guide",
        title: "Guide",
        default: true,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          id: `page-${index + 1}`,
          title: `Page ${index + 1}`,
          description: `Document public workflow ${index + 1} with stable published guidance.`,
        })),
      },
    ],
  };
}

function reusableStateWithPages(
  structure: DocumentationStructure,
  trackChangedRoute: boolean = true,
): ReusableGenerationState {
  const reusableState = reusableStateFor(sourceState);
  const hashes = buildPageInputHashMap(structure);
  reusableState.manifest.planningFingerprint = "planning-v1";
  reusableState.manifest.writingFingerprint = "writing-v1";
  reusableState.structure.structure = toJsonValue(structure);
  reusableState.pages = structure.sections[0]!.pages.map((page) => {
    const pageId = `${structure.sections[0]!.id}/${page.id}`;
    return {
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      pageId,
      title: page.title,
      route: `/${page.id}`,
      navigationPath: `default/${page.id}/index.mdx`,
      artifactKey: `sites/site-1/pages/${page.id}.mdx`,
      contentHash: "e".repeat(64),
      pageInputHash: hashes[pageId]!,
      dependencies: {
        sourceFilesRead:
          trackChangedRoute && page.id === "page-3"
            ? ["apps/api/src/routes/flags.ts"]
            : [],
        sourceFilesDiscovered: [],
        sourceEvidenceFiles: [],
        referencedSymbols: [],
        referencedRoutes: [],
      },
    };
  });
  return reusableState;
}

function sourceStateWithFiles(
  treeHash: string,
  files: GenerationSourceState["files"],
): GenerationSourceState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    sourceRevision: targetRevision,
    sourceTreeHash: treeHash,
    files,
  };
}

function sourceFile(
  path: string,
  hashCharacter: string,
): GenerationSourceState["files"][number] {
  return {
    path,
    contentHash: hashCharacter.repeat(64),
    contentKind: "text",
  };
}

function reusableStateFor(
  source: GenerationSourceState,
): ReusableGenerationState {
  const objectHash = "f".repeat(64);
  return {
    manifest: {
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      siteId: "site-1",
      versionId: "version-1",
      baselineVersionId: null,
      generatorFingerprint: "doxa-hosted-generator-v1",
      sourceRevision: source.sourceRevision,
      sourceTreeHash: source.sourceTreeHash,
      source: {
        key: "sites/site-1/generation-state/version-1/source.json",
        hash: objectHash,
      },
      analysis: {
        key: "sites/site-1/generation-state/version-1/analysis.json",
        hash: objectHash,
      },
      structure: {
        key: "sites/site-1/generation-state/version-1/structure.json",
        hash: objectHash,
      },
      pages: [],
      createdAt: "2026-07-24T00:00:00.000Z",
    },
    source,
    analysis: {
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      analysis: { projectName: "FlagForge" },
      analysisHash: objectHash,
      sourceSummaries: [],
    },
    structure: {
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      structure: { sections: [] },
      structureHash: objectHash,
      structuralFingerprint: objectHash,
    },
    pages: [],
  };
}

function flagForgeAnalysisWithUndefinedFields(): ProjectAnalysis {
  return {
    projectName: "FlagForge",
    configFiles: [
      {
        path: "vite.config.ts",
        description: "Vite configuration",
        schema: undefined,
      },
    ],
    documentationCollections: [
      {
        id: "packages",
        title: "Packages",
        description: undefined,
        kind: "package",
        sourceEvidence: [
          {
            path: "package.json",
            kind: undefined,
            title: undefined,
          },
        ],
        items: [
          {
            id: "sdk",
            title: "SDK",
            slug: "sdk",
            description: undefined,
            packageName: undefined,
            installCommand: undefined,
            sourceEvidence: [
              {
                path: "packages/sdk/src/index.ts",
                kind: undefined,
                title: undefined,
              },
            ],
          },
        ],
      },
    ],
  } as ProjectAnalysis;
}
