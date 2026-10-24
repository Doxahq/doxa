import {
  GENERATION_STATE_SCHEMA_VERSION,
  commitCheckoutSchema,
  emptyPageDependencyState,
  generationAnalysisStateSchema,
  generationPageStateSchema,
  generationSourceStateSchema,
  generationStateManifestSchema,
  generationStructureStateSchema,
  incrementalGenerationPlanSchema,
  pullRequestMergeCheckoutSchema,
  repositorySnapshotSchema,
  sourceChangeSchema,
  sourceCheckoutSpecSchema,
  stagedRuntimePageSchema,
} from "@doxahq/contracts";
import {
  createRepositorySnapshot,
  normalizeSourceChanges,
} from "../src/source-checkout";
import { describe, expect, test } from "vitest";

const baselineRevision = "a".repeat(40);
const baseRevision = "b".repeat(40);
const headRevision = "c".repeat(40);
const sourceTreeHash = "d".repeat(40);
const contentHash = "e".repeat(64);
const stateHash = "f".repeat(64);

describe("source checkout contracts", () => {
  test("round-trips exact checkout revisions", () => {
    const pullRequest = {
      kind: "pull_request_merge" as const,
      pullRequestNumber: 42,
      baselineRevision,
      baseRevision,
      headRevision,
    };
    const commit = {
      kind: "commit" as const,
      baselineRevision,
      targetRevision: headRevision,
    };

    expect(pullRequestMergeCheckoutSchema.parse(pullRequest)).toEqual(
      pullRequest,
    );
    expect(commitCheckoutSchema.parse(commit)).toEqual(commit);
    expect(sourceCheckoutSpecSchema.parse(pullRequest)).toEqual(
      pullRequest,
    );
    expect(sourceCheckoutSpecSchema.parse(commit)).toEqual(commit);
  });

  test.each([
    ["short", "a".repeat(39)],
    ["uppercase", "A".repeat(40)],
    ["non-hexadecimal", "z".repeat(40)],
  ])("rejects %s Git object IDs", (_name, revision) => {
    expect(
      commitCheckoutSchema.safeParse({
        kind: "commit",
        baselineRevision,
        targetRevision: revision,
      }).success,
    ).toBe(false);
  });

  test.each([
    "/absolute.ts",
    "src\\windows.ts",
    "../outside.ts",
    "src/../outside.ts",
    "./src/index.ts",
    "src//index.ts",
    "src/index.ts/",
    "",
  ])("rejects non-normalized source path %j", (path) => {
    expect(
      sourceChangeSchema.safeParse({
        path,
        status: "modified",
      }).success,
    ).toBe(false);
  });

  test("requires rename provenance", () => {
    expect(
      sourceChangeSchema.parse({
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        status: "renamed",
      }),
    ).toEqual({
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      status: "renamed",
    });

    expect(
      sourceChangeSchema.safeParse({
        path: "src/new-name.ts",
        status: "renamed",
      }).success,
    ).toBe(false);
  });

  test("rejects rename provenance for non-renamed changes", () => {
    expect(
      sourceChangeSchema.safeParse({
        path: "src/index.ts",
        previousPath: "src/old.ts",
        status: "modified",
      }).success,
    ).toBe(false);
  });

  test("normalizes source changes into deterministic order", () => {
    const changes = normalizeSourceChanges([
      { path: "src/z.ts", status: "deleted" },
      { path: "src/a.ts", status: "added" },
      {
        path: "src/b.ts",
        previousPath: "src/old-b.ts",
        status: "renamed",
      },
    ]);

    expect(changes.map((change) => change.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/z.ts",
    ]);
    expect(
      createRepositorySnapshot({
        targetRevision: headRevision,
        sourceTreeHash,
        changes,
      }),
    ).toEqual({
      targetRevision: headRevision,
      sourceTreeHash,
      changes,
    });
  });

  test("rejects unordered or duplicate repository snapshots", () => {
    expect(
      repositorySnapshotSchema.safeParse({
        targetRevision: headRevision,
        sourceTreeHash,
        changes: [
          { path: "src/z.ts", status: "modified" },
          { path: "src/a.ts", status: "modified" },
        ],
      }).success,
    ).toBe(false);

    expect(() =>
      normalizeSourceChanges([
        { path: "src/a.ts", status: "modified" },
        { path: "src/a.ts", status: "deleted" },
      ]),
    ).toThrow("Duplicate source change for src/a.ts.");
  });
});

describe("permanent generation-state contracts", () => {
  const dependencies = {
    sourceFilesRead: ["src/a.ts"],
    sourceFilesDiscovered: ["src/b.ts"],
    sourceEvidenceFiles: ["src/routes.ts"],
    referencedSymbols: ["createApp"],
    referencedRoutes: ["/reference/create-app"],
  };

  const sourceState = {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    sourceRevision: headRevision,
    sourceTreeHash,
    files: [
      {
        path: "src/a.ts",
        contentHash,
        contentKind: "text" as const,
      },
    ],
  };
  const analysisState = {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    analysis: { projectName: "Doxa", frameworks: ["Hono"] },
    analysisHash: contentHash,
    sourceSummaries: [
      {
        path: "src/a.ts",
        contentHash,
        summary: { exports: ["createApp"] },
      },
    ],
  };
  const structureState = {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    structure: { sections: [{ id: "default", pages: ["overview"] }] },
    structureHash: contentHash,
    structuralFingerprint: stateHash,
  };
  const pageState = {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId: "overview",
    title: "Overview",
    route: "/",
    navigationPath: "default/overview.md",
    artifactKey: "sites/site-1/versions/version-1/pages/overview.mdx",
    contentHash,
    pageInputHash: stateHash,
    dependencies,
  };
  const manifest = {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    siteId: "site-1",
    versionId: "version-1",
    baselineVersionId: "version-0",
    generatorFingerprint: "doxabot-v1",
    sourceRevision: headRevision,
    sourceTreeHash,
    source: {
      key: "sites/site-1/generation-state/version-1/source.json",
      hash: stateHash,
    },
    analysis: {
      key: "sites/site-1/generation-state/version-1/analysis.json",
      hash: stateHash,
    },
    structure: {
      key: "sites/site-1/generation-state/version-1/structure.json",
      hash: stateHash,
    },
    pages: [
      {
        pageId: "overview",
        record: {
          key: "sites/site-1/generation-state/version-1/pages/overview.json",
          hash: stateHash,
        },
        artifactKey:
          "sites/site-1/versions/version-1/default/overview.md",
        contentHash,
      },
    ],
    createdAt: "2026-07-23T12:00:00.000Z",
  };

  test("round-trips every versioned state artifact", () => {
    expect(generationSourceStateSchema.parse(sourceState)).toEqual(
      sourceState,
    );
    expect(generationAnalysisStateSchema.parse(analysisState)).toEqual(
      analysisState,
    );
    expect(generationStructureStateSchema.parse(structureState)).toEqual(
      structureState,
    );
    expect(generationPageStateSchema.parse(pageState)).toEqual(pageState);
    expect(generationStateManifestSchema.parse(manifest)).toEqual(
      manifest,
    );
  });

  test("keeps new regeneration causes compatible with legacy plans", () => {
    const legacyPlan = {
      analysisMode: "incremental" as const,
      structureMode: "regenerate" as const,
      regeneratePageIds: ["overview"],
      reusePageIds: ["guide"],
      removedPageIds: [],
      modelCallsRequired: true,
      reasons: ["Structure changed."],
    };
    const classifiedPlan = {
      ...legacyPlan,
      causes: {
        newPages: 0,
        inputChanged: 0,
        dependencyChanged: 1,
      },
    };

    expect(incrementalGenerationPlanSchema.parse(legacyPlan)).toEqual(
      legacyPlan,
    );
    expect(incrementalGenerationPlanSchema.parse(classifiedPlan)).toEqual(
      classifiedPlan,
    );
    expect(
      incrementalGenerationPlanSchema.safeParse({
        ...classifiedPlan,
        causes: {
          ...classifiedPlan.causes,
          dependencyChanged: 0,
        },
      }).success,
    ).toBe(false);
  });

  test.each([
    {
      schema: generationSourceStateSchema,
      value: sourceState,
    },
    {
      schema: generationAnalysisStateSchema,
      value: analysisState,
    },
    {
      schema: generationStructureStateSchema,
      value: structureState,
    },
    {
      schema: generationPageStateSchema,
      value: pageState,
    },
    {
      schema: generationStateManifestSchema,
      value: manifest,
    },
  ])("rejects unsupported schema versions", ({ schema, value }) => {
    expect(
      schema.safeParse({
        ...value,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
  });

  test("rejects unordered dependency evidence", () => {
    expect(
      generationPageStateSchema.safeParse({
        ...pageState,
        dependencies: {
          ...dependencies,
          sourceFilesRead: ["src/z.ts", "src/a.ts"],
        },
      }).success,
    ).toBe(false);
  });

  test("extends staged pages with validated dependency evidence", () => {
    const stagedPage = {
      id: "overview",
      title: "Overview",
      route: "/",
      navigationPath: "default/overview.md",
      content: "# Overview\n",
      dependencies: emptyPageDependencyState(),
      contentHash,
      pageInputHash: stateHash,
    };

    expect(stagedRuntimePageSchema.parse(stagedPage)).toEqual(
      stagedPage,
    );
  });
});
