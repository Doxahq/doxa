import {
  GENERATION_STATE_SCHEMA_VERSION,
  generationAnalysisStateSchema,
  generationStructureStateSchema,
  toJsonValue,
  type GenerationAnalysisState,
  type GenerationSourceState,
  type GenerationStructureState,
  type IncrementalGenerationPlan,
  type RepositorySnapshot,
  type ReusableGenerationState,
  type SeedSite,
} from "@doxahq/contracts";
import {
  analyzeProjectOnly,
  baselinePageInputHashes,
  buildPageInputHashMap,
  buildStructuralFingerprint,
  documentationBriefFingerprint,
  evidencePaths,
  flattenStructure,
  hashObject,
  isDocumentationStructure,
  isDocumentationRelevantSourcePath,
  discoverSpecFiles,
  normalizeProjectAnalysis,
  planPageEdits,
  planPagesAgainstBaseline,
  planRevisionAwareGeneration,
  resolveDocumentationBrief,
  seedStructureFromSite,
  sourceChangePaths,
  stablePageId,
  templateRenderedPageIds,
  type AgentCacheManager,
  type AgentConfig,
  type AgentProgressCallback,
  type DocumentationStructure,
  type PageEdit,
  type ProjectAnalysis,
  type RevisionSourceChange,
} from "@doxahq/agent";

export interface IncrementalAnalysisResult {
  analysis: ProjectAnalysis;
  analysisState: GenerationAnalysisState;
  preliminaryPlan: IncrementalGenerationPlan;
  structuralFingerprint: string;
}

export async function analyzeIncrementalGeneration(input: {
  config: AgentConfig;
  planningFingerprint: string;
  writingFingerprint: string;
  onProgress?: AgentProgressCallback;
  reusableState?: ReusableGenerationState;
  snapshot: RepositorySnapshot;
  sourceState: GenerationSourceState;
}): Promise<IncrementalAnalysisResult> {
  const structuralFingerprint = await buildStructuralFingerprint(
    input.sourceState.files,
  );
  const previous = previousPlanningState(input.reusableState);
  const previousStructure = reusableStructure(input.reusableState);
  // The published page state is keyed by the stable page ID and by the page
  // input hash of the writer. The preliminary plan must use the same two
  // functions, or no current page matches its baseline record.
  const preliminaryPlan = planRevisionAwareGeneration({
    currentPageIds: previousStructure
      ? flattenStructure(previousStructure).map(stablePageId)
      : [],
    currentPageInputHashes: previousStructure
      ? buildPageInputHashMap(previousStructure)
      : {},
    changes: input.snapshot.changes,
    planningFingerprint: input.planningFingerprint,
    writingFingerprint: input.writingFingerprint,
    structuralFingerprint,
    previous,
    structuralPaths: await specStructuralPaths(input.config, input.reusableState),
  });

  const analysis = await resolveAnalysis({
    config: input.config,
    onProgress: input.onProgress,
    plan: preliminaryPlan,
    reusableState: input.reusableState,
    snapshot: input.snapshot,
  });
  const persistentAnalysis = toJsonValue(analysis);
  const analysisState = generationAnalysisStateSchema.parse({
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    analysis: persistentAnalysis,
    analysisHash: hashObject(persistentAnalysis),
    documentationBriefFingerprint: documentationBriefFingerprint(
      resolveDocumentationBrief(input.config.documentationBrief),
    ),
    sourceSummaries: mergeSourceSummaries(
      input.sourceState,
      input.reusableState,
    ),
  });
  return {
    analysis,
    analysisState,
    preliminaryPlan,
    structuralFingerprint,
  };
}

/**
 * Spec files whose change is structural: every file of the published REST
 * reference, and every spec file in the checkout now. A spec that a change
 * adds, under any name that discovery finds, then adds its endpoint pages.
 */
async function specStructuralPaths(
  config: AgentConfig,
  reusableState: ReusableGenerationState | undefined,
): Promise<ReadonlySet<string>> {
  const current = await discoverSpecFiles(config.cwd, config.restApiSpecPaths);
  return new Set([...previousSpecFiles(reusableState), ...current]);
}

/** The spec files that the published REST reference came from, with every file their `$ref`s used. */
function previousSpecFiles(reusableState: ReusableGenerationState | undefined): string[] {
  const analysis = reusableState ? normalizeProjectAnalysis(reusableState.analysis.analysis) : undefined;
  return analysis?.referenceSurfaces?.rest?.source?.files ?? [];
}

export async function finalizeIncrementalPlan(input: {
  analysis: ProjectAnalysis;
  documentationBrief: AgentConfig["documentationBrief"];
  planningFingerprint: string;
  writingFingerprint: string;
  reusableState?: ReusableGenerationState;
  snapshot: RepositorySnapshot;
  structuralFingerprint: string;
  structure: DocumentationStructure;
  preliminaryPlan: IncrementalGenerationPlan;
}): Promise<{
  plan: IncrementalGenerationPlan;
  structureState: GenerationStructureState;
}> {
  const currentPageIds = flattenStructure(input.structure).map(stablePageId);
  const currentPageInputHashes = buildPageInputHashMap(input.structure);
  const templatePageIds = new Set(templateRenderedPageIds(input.structure));
  const previous = previousPlanningState(input.reusableState);
  const plan = input.preliminaryPlan.structureMode === "reuse"
    ? planRevisionAwareGeneration({
        currentPageIds,
        currentPageInputHashes,
        changes: input.snapshot.changes,
        planningFingerprint: input.planningFingerprint,
        writingFingerprint: input.writingFingerprint,
        structuralFingerprint: input.structuralFingerprint,
        previous,
        templatePageIds,
      })
    : planAfterNewStructure({
        currentPageIds,
        currentPageInputHashes,
        changes: input.snapshot.changes,
        planningFingerprint: input.planningFingerprint,
        writingFingerprint: input.writingFingerprint,
        preliminaryPlan: input.preliminaryPlan,
        previous,
        templatePageIds,
      });
  const pageEdits = editsForPlan(plan, input);
  const persistentStructure = toJsonValue(input.structure);
  return {
    plan: Object.keys(pageEdits).length > 0 ? { ...plan, pageEdits } : plan,
    structureState: generationStructureStateSchema.parse({
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      structure: persistentStructure,
      structureHash: hashObject(persistentStructure),
      structuralFingerprint: input.structuralFingerprint,
    }),
  };
}

/** The regenerated baseline pages that the writer edits, with the changed files behind each. */
function editsForPlan(
  plan: IncrementalGenerationPlan,
  input: {
    reusableState?: ReusableGenerationState;
    snapshot: RepositorySnapshot;
    structure: DocumentationStructure;
  },
): Record<string, PageEdit> {
  const targets = flattenStructure(input.structure);
  return planPageEdits({
    plan,
    previousPages: input.reusableState?.pages ?? [],
    currentEvidencePaths: Object.fromEntries(
      targets.map((target) => [stablePageId(target), evidencePaths(target.page.sourceEvidence)]),
    ),
    changedPaths: new Set(sourceChangePaths(input.snapshot.changes)),
    templatePageIds: new Set(templateRenderedPageIds(input.structure)),
  });
}

/**
 * The page plan once the run has a new structure, planned again or patched:
 * each page is compared with its baseline record. After a new plan, relevant
 * changes that no page depends on rewrite every page, since the plan may have
 * moved what they document. A patch keeps every editorial page and rebuilds
 * the reference pages from analysis, so it rewrites only the pages it finds.
 */
function planAfterNewStructure(input: {
  currentPageIds: string[];
  currentPageInputHashes: Readonly<Record<string, string>>;
  changes: readonly RevisionSourceChange[];
  planningFingerprint: string;
  writingFingerprint: string;
  preliminaryPlan: IncrementalGenerationPlan;
  previous: ReturnType<typeof previousPlanningState>;
  templatePageIds: ReadonlySet<string>;
}): IncrementalGenerationPlan {
  const structureMode = input.preliminaryPlan.structureMode === "patch" ? "patch" : "regenerate";
  if (!input.previous) {
    return regenerateAllPages(
      input.currentPageIds,
      [],
      "No compatible published generation state is available.",
      "full",
    );
  }

  if (
    input.previous.planningFingerprint !== undefined &&
    input.previous.planningFingerprint !== input.planningFingerprint
  ) {
    return regenerateAllPages(
      input.currentPageIds,
      removedPageIds(input.currentPageIds, input.previous.pages),
      "The documentation planning contract changed.",
      "full",
    );
  }

  if (
    input.previous.writingFingerprint !== undefined &&
    input.previous.writingFingerprint !== input.writingFingerprint
  ) {
    return regenerateAllPages(
      input.currentPageIds,
      removedPageIds(input.currentPageIds, input.previous.pages),
      "The writer contract changed; the regenerated structure remains usable but every page must be rewritten.",
      input.preliminaryPlan.analysisMode,
      structureMode,
    );
  }

  const changedSourcePaths = sourceChangePaths(input.changes);
  const pagePlan = planPagesAgainstBaseline({
    currentPageIds: input.currentPageIds,
    currentPageInputHashes: input.currentPageInputHashes,
    dependencyChangePaths: new Set(changedSourcePaths),
    previous: input.previous,
    templatePageIds: input.templatePageIds,
  });
  const hasDocumentationRelevantChanges = changedSourcePaths.some(
    isDocumentationRelevantSourcePath,
  );
  if (
    structureMode === "regenerate" &&
    pagePlan.regeneratePageIds.length === 0 &&
    hasDocumentationRelevantChanges
  ) {
    return regenerateAllPages(
      input.currentPageIds,
      pagePlan.removedPageIds,
      "Documentation-relevant source changes are not mapped to prior page dependencies.",
      input.preliminaryPlan.analysisMode,
    );
  }

  return {
    analysisMode: input.preliminaryPlan.analysisMode,
    structureMode,
    ...pagePlan,
    modelCallsRequired: pagePlan.regeneratePageIds.length > 0,
  };
}

function regenerateAllPages(
  currentPageIds: string[],
  removedPageIds: string[],
  reason: string,
  analysisMode: IncrementalGenerationPlan["analysisMode"],
  structureMode: IncrementalGenerationPlan["structureMode"] = "regenerate",
): IncrementalGenerationPlan {
  return {
    analysisMode,
    structureMode,
    regeneratePageIds: currentPageIds,
    reusePageIds: [],
    removedPageIds,
    modelCallsRequired: currentPageIds.length > 0,
    reasons: [reason],
  };
}

function removedPageIds(
  currentPageIds: readonly string[],
  previousPages: readonly { pageId: string }[],
): string[] {
  const currentPageIdSet = new Set(currentPageIds);
  return previousPages
    .map((page) => page.pageId)
    .filter((pageId) => !currentPageIdSet.has(pageId));
}

export function reusableStructure(
  reusableState: ReusableGenerationState | undefined,
): DocumentationStructure | null {
  const value = reusableState?.structure.structure;
  if (!isDocumentationStructure(value)) {
    return null;
  }
  return value;
}

/**
 * The structure of the hand-written site of a seeded first generation, or
 * null for any other run.
 */
export function seedStructure(
  seedSite: SeedSite | undefined,
): DocumentationStructure | null {
  return seedSite ? seedStructureFromSite(seedSite) : null;
}

async function resolveAnalysis(input: {
  config: AgentConfig;
  onProgress?: AgentProgressCallback;
  plan: IncrementalGenerationPlan;
  reusableState?: ReusableGenerationState;
  snapshot: RepositorySnapshot;
}): Promise<ProjectAnalysis> {
  const reusableAnalysis = input.reusableState
    ? normalizeProjectAnalysis(input.reusableState.analysis.analysis)
    : null;
  if (input.plan.analysisMode === "reuse" && reusableAnalysis) {
    input.onProgress?.({
      stage: "analyzing",
      message: "Reusing published project analysis.",
      progress: 100,
    });
    return reusableAnalysis;
  }
  if (
    input.plan.analysisMode === "incremental" &&
    input.reusableState &&
    reusableAnalysis
  ) {
    return analyzeProjectOnly(
      input.config,
      input.onProgress,
      reusableAnalysisCache(
        input.reusableState,
        input.snapshot,
      ),
    );
  }
  return analyzeProjectOnly(input.config, input.onProgress);
}

function reusableAnalysisCache(
  reusableState: ReusableGenerationState,
  snapshot: RepositorySnapshot,
): AgentCacheManager {
  const changes = analysisSourceChanges(snapshot.changes);
  const persistedAnalysis = reusableState.analysis.analysis;
  const cachedAnalysis = isRecord(persistedAnalysis)
    ? {
        ...persistedAnalysis,
        ...(reusableState.analysis.documentationBriefFingerprint
          ? {
              __doxaDocumentationBriefFingerprint:
                reusableState.analysis.documentationBriefFingerprint,
            }
          : {}),
      }
    : {};
  return {
    async checkAnalysis() {
      return {
        needsReanalysis: true,
        cachedAnalysis,
        cachedExplorationContext: "validated permanent generation state",
        currentCommitHash: snapshot.targetRevision,
        ...changes,
      };
    },
    async saveAnalysis() {},
    async checkDocs() {
      throw new Error(
        "The reusable analysis cache cannot serve documentation pages.",
      );
    },
    async saveDocs() {
      throw new Error(
        "The reusable analysis cache cannot store documentation pages.",
      );
    },
    async updateDocPages() {
      throw new Error(
        "The reusable analysis cache cannot update documentation pages.",
      );
    },
  };
}

function analysisSourceChanges(
  changes: readonly RevisionSourceChange[],
): {
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
} {
  const changedFiles: string[] = [];
  const addedFiles: string[] = [];
  const deletedFiles: string[] = [];
  for (const change of changes.filter((candidate) =>
    sourceChangePaths([candidate]).some(isDocumentationRelevantSourcePath)
  )) {
    if (change.status === "modified") {
      changedFiles.push(change.path);
    } else if (change.status === "added") {
      addedFiles.push(change.path);
    } else if (change.status === "deleted") {
      deletedFiles.push(change.path);
    } else {
      addedFiles.push(change.path);
      if (change.previousPath) {
        deletedFiles.push(change.previousPath);
      }
    }
  }
  return {
    changedFiles: sortedUnique(changedFiles),
    addedFiles: sortedUnique(addedFiles),
    deletedFiles: sortedUnique(deletedFiles),
  };
}

function mergeSourceSummaries(
  sourceState: GenerationSourceState,
  reusableState: ReusableGenerationState | undefined,
): GenerationAnalysisState["sourceSummaries"] {
  const previousByPath = new Map(
    reusableState?.analysis.sourceSummaries.map((summary) => [
      summary.path,
      summary,
    ]) ?? [],
  );
  return sourceState.files.map((file) => {
    const previous = previousByPath.get(file.path);
    if (previous?.contentHash === file.contentHash) {
      return previous;
    }
    return {
      path: file.path,
      contentHash: file.contentHash,
      summary: {
        contentKind: file.contentKind,
        state: "changed",
      },
    };
  });
}

/**
 * The baseline that a run compares its pages with. Its page input hashes are
 * read with the current rule (see `baselinePageInputHashes`), so a change of
 * the rule rewrites no page.
 */
function previousPlanningState(
  reusableState: ReusableGenerationState | undefined,
) {
  if (!reusableState) {
    return null;
  }
  const previousStructure = reusableStructure(reusableState);
  const storedHashes = Object.fromEntries(
    reusableState.pages.map((page) => [page.pageId, page.pageInputHash]),
  );
  const comparableHashes = previousStructure
    ? baselinePageInputHashes(previousStructure, storedHashes)
    : storedHashes;
  return {
    planningFingerprint:
      reusableState.manifest.planningFingerprint,
    writingFingerprint:
      reusableState.manifest.writingFingerprint,
    structuralFingerprint:
      reusableState.structure.structuralFingerprint,
    pages: reusableState.pages.map((page) => ({
      pageId: page.pageId,
      pageInputHash: comparableHashes[page.pageId] ?? page.pageInputHash,
      dependencies: page.dependencies,
    })),
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
