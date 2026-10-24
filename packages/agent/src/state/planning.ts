import type { DocumentationGenerationBrief, DocumentationStructure, ProjectAnalysis } from "../types";
import { documentationBriefFingerprint, resolveDocumentationBrief } from "../doxa-agent/documentation-policy";
import { hashValue } from "../utils/hash";
import { evidencePaths, normalizedBrief } from "./page-input";
import { flattenStructure } from "./page-targets";
import type {
  CachedPageEntry,
  DocsGenerationPlan,
  DocsManifest,
  PageTarget,
  PageDependencyState,
  RegenerationCauses,
  RevisionAwareGenerationPlan,
  RevisionSourceChange,
  SourceChangeSet,
} from "./types";
import {
  isDocsConfigPath,
  isDocumentationRelevantSourcePath,
  isPackageManifestPath,
  isStructuralSourcePath,
  sourceChangePaths,
} from "./source-changes";

export async function buildStructureHash(structure: DocumentationStructure): Promise<string> {
  return hashValue(structure);
}

export async function buildAnalysisHash(
  analysis: ProjectAnalysis | null | undefined,
  documentationBrief?: DocumentationGenerationBrief,
): Promise<string> {
  return analysis ? hashValue({
    analysis,
    documentationBriefFingerprint: documentationBriefFingerprint(
      resolveDocumentationBrief(documentationBrief),
    ),
  }) : "";
}

export async function buildPageInputHash(target: PageTarget): Promise<string> {
  return hashValue({
    pageId: target.pageId,
    title: target.title,
    sectionTitle: target.sectionTitle,
    outputPath: target.outputPath,
    description: normalizedBrief(target.description),
    sourceEvidence: evidencePaths(target.sourceEvidence),
    parentPageId: target.parentPageId,
    collectionId: target.collectionId,
    collectionItemId: target.collectionItemId,
    reference: target.reference,
  });
}

export async function buildPageInputHashes(targets: PageTarget[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    targets.map(async (target) => [target.pageId, await buildPageInputHash(target)] as const),
  );
  return Object.fromEntries(entries);
}

export function planDocsGeneration(input: {
  allPageIds: string[];
  pageInputHashes: Record<string, string>;
  previousManifest: DocsManifest | null;
  sourceChanges: SourceChangeSet;
  force?: boolean;
  currentAnalysisHash: string;
}): DocsGenerationPlan {
  const { allPageIds, pageInputHashes, previousManifest, sourceChanges, currentAnalysisHash } = input;

  if (input.force || !previousManifest) {
    return {
      needsGeneration: true,
      pagesToGenerate: allPageIds,
      pagesFromCache: [],
      reasons: Object.fromEntries(allPageIds.map((id) => [id, input.force ? "Forced regeneration" : "No manifest exists"])),
    };
  }

  const changedFiles = new Set([
    ...sourceChanges.changedFiles,
    ...sourceChanges.addedFiles,
    ...sourceChanges.deletedFiles,
  ]);
  const cachedPageById = new Map<string, CachedPageEntry>();
  for (const page of previousManifest.pages) cachedPageById.set(page.pageId, page);

  const pagesToGenerate: string[] = [];
  const pagesFromCache: string[] = [];
  const reasons: Record<string, string> = {};
  const analysisChanged = previousManifest.analysisHash !== currentAnalysisHash;

  for (const pageId of allPageIds) {
    const cached = cachedPageById.get(pageId);
    if (!cached) {
      pagesToGenerate.push(pageId);
      reasons[pageId] = "New page";
      continue;
    }

    const inputHash = pageInputHashes[pageId];
    if (cached.pageInputHash !== inputHash) {
      pagesToGenerate.push(pageId);
      reasons[pageId] = "Page inputs changed";
      continue;
    }
    if (!isPageDependencyState(cached.dependencies)) {
      pagesToGenerate.push(pageId);
      reasons[pageId] = "Validated page dependency state is missing";
      continue;
    }

    const dependencies = [
      ...cached.dependencies.sourceFilesRead,
      ...cached.dependencies.sourceFilesDiscovered,
      ...cached.dependencies.sourceEvidenceFiles,
    ];
    const affected = dependencies.filter((dep) => changedFiles.has(dep));
    if (affected.length > 0) {
      pagesToGenerate.push(pageId);
      reasons[pageId] = `Source files changed: ${affected.slice(0, 3).join(", ")}`;
      continue;
    }

    if (analysisChanged && dependencies.length === 0) {
      pagesToGenerate.push(pageId);
      reasons[pageId] = "Analysis changed and page has no tracked dependencies";
      continue;
    }

    pagesFromCache.push(pageId);
  }

  return {
    needsGeneration: pagesToGenerate.length > 0,
    pagesToGenerate,
    pagesFromCache,
    reasons,
  };
}

export async function createDocsPlanningContext(input: {
  structure: DocumentationStructure;
  analysis: ProjectAnalysis | null;
  documentationBrief?: DocumentationGenerationBrief;
}) {
  const targets = flattenStructure(input.structure);
  const pageInputHashes = await buildPageInputHashes(targets);
  return {
    targets,
    allPageIds: targets.map((target) => target.pageId),
    pageInputHashes,
    structureHash: await buildStructureHash(input.structure),
    analysisHash: await buildAnalysisHash(input.analysis, input.documentationBrief),
  };
}

export interface PriorRevisionGenerationState {
  planningFingerprint?: string;
  writingFingerprint?: string;
  structuralFingerprint: string;
  pages: Array<{
    pageId: string;
    pageInputHash: string;
    dependencies: PageDependencyState;
  }>;
}

export function planPagesAgainstBaseline(input: {
  currentPageIds: readonly string[];
  currentPageInputHashes: Readonly<Record<string, string>>;
  dependencyChangePaths: ReadonlySet<string>;
  previous: PriorRevisionGenerationState;
  /**
   * Pages that a template renders from their inputs alone. Only their input
   * hash decides: a changed spec file rewrites only the endpoint pages whose
   * facts changed, not every page that cites the file.
   */
  templatePageIds?: ReadonlySet<string>;
}): {
  regeneratePageIds: string[];
  reusePageIds: string[];
  removedPageIds: string[];
  reasons: string[];
  causes: RegenerationCauses;
} {
  const currentPageIds = uniqueInOrder(input.currentPageIds);
  const currentPageIdSet = new Set(currentPageIds);
  const removedPageIds = input.previous.pages
    .map((page) => page.pageId)
    .filter((pageId) => !currentPageIdSet.has(pageId));
  const previousById = new Map(
    input.previous.pages.map((page) => [page.pageId, page]),
  );
  const regeneratePageIds: string[] = [];
  const reusePageIds: string[] = [];
  const reasons: string[] = [];
  const causes: RegenerationCauses = {
    newPages: 0,
    inputChanged: 0,
    dependencyChanged: 0,
  };

  for (const pageId of currentPageIds) {
    const page = previousById.get(pageId);
    if (!page) {
      regeneratePageIds.push(pageId);
      causes.newPages += 1;
      reasons.push(`Page ${pageId} is new.`);
      continue;
    }
    if (page.pageInputHash !== input.currentPageInputHashes[pageId]) {
      regeneratePageIds.push(pageId);
      causes.inputChanged += 1;
      reasons.push(`Page ${pageId} inputs changed.`);
      continue;
    }
    if (input.templatePageIds?.has(pageId)) {
      reusePageIds.push(pageId);
      continue;
    }
    const affectedDependencies = dependencyPaths(page.dependencies).filter(
      (path) => input.dependencyChangePaths.has(path),
    );
    if (affectedDependencies.length > 0) {
      regeneratePageIds.push(pageId);
      causes.dependencyChanged += 1;
      reasons.push(
        `Page ${pageId} depends on changed source: ${affectedDependencies.slice(0, 3).join(", ")}.`,
      );
      continue;
    }
    reusePageIds.push(pageId);
  }

  return {
    regeneratePageIds,
    reusePageIds,
    removedPageIds,
    causes,
    reasons: reasons.length > 0
      ? reasons
      : ["All current pages match the published page inputs and dependencies."],
  };
}

export function planRevisionAwareGeneration(input: {
  currentPageIds: readonly string[];
  currentPageInputHashes: Readonly<Record<string, string>>;
  changes: readonly RevisionSourceChange[];
  planningFingerprint: string;
  writingFingerprint: string;
  structuralFingerprint: string;
  previous: PriorRevisionGenerationState | null;
  /** Template-rendered pages, which follow their input hash only. */
  templatePageIds?: ReadonlySet<string>;
  /**
   * Files whose change is structural for this project beyond the name
   * rules, such as the spec files that its REST reference came from.
   */
  structuralPaths?: ReadonlySet<string>;
}): RevisionAwareGenerationPlan {
  const currentPageIds = uniqueInOrder(input.currentPageIds);
  const previous = input.previous;
  if (!previous) {
    return fullPlan(
      currentPageIds,
      [],
      "No compatible published generation state is available.",
    );
  }
  const previousPageIds = previous.pages.map((page) => page.pageId);
  const currentPageIdSet = new Set(currentPageIds);
  const removedPageIds = previousPageIds.filter(
    (pageId) => !currentPageIdSet.has(pageId),
  );
  if (
    previous.planningFingerprint !== undefined &&
    previous.planningFingerprint !== input.planningFingerprint
  ) {
    return fullPlan(
      currentPageIds,
      removedPageIds,
      "The documentation planning contract changed.",
    );
  }

  const relevantChanges = input.changes.filter((change) =>
    sourceChangePaths([change]).some(isDocumentationRelevantSourcePath)
  );
  if (relevantChanges.length === 0) {
    if (
      previous.writingFingerprint !== undefined &&
      previous.writingFingerprint !== input.writingFingerprint
    ) {
      return rewritePlan(
        currentPageIds,
        removedPageIds,
        "The writer contract changed; existing analysis and structure remain reusable.",
      );
    }
    // A page whose own inputs changed is written again although no source
    // changed, such as an endpoint page after a new template version.
    const inputChangedPageIds = currentPageIds.filter((pageId) => {
      const published = previous.pages.find((page) => page.pageId === pageId);
      return published !== undefined && published.pageInputHash !== input.currentPageInputHashes[pageId];
    });
    const inputChanged = new Set(inputChangedPageIds);
    return {
      analysisMode: "reuse",
      structureMode: "reuse",
      regeneratePageIds: inputChangedPageIds,
      reusePageIds: currentPageIds.filter((pageId) =>
        previousPageIds.includes(pageId) && !inputChanged.has(pageId)
      ),
      removedPageIds,
      // The plan contract counts every page to write, a template page too.
      modelCallsRequired: inputChangedPageIds.length > 0,
      reasons: inputChangedPageIds.length > 0
        ? [`${inputChangedPageIds.length} page(s) have new page inputs; source changes do not affect the others.`]
        : ["Source changes do not affect published documentation."],
    };
  }

  const structuralChanges = relevantChanges.filter((change) =>
    sourceChangePaths([change]).some((path) =>
      isStructuralSourcePath(path) || input.structuralPaths?.has(path) === true
    )
  );
  if (structuralChanges.length > 0) {
    return canPatchStructure(structuralChanges)
      ? fullPlan(
          currentPageIds,
          removedPageIds,
          "Routes or schemas changed; the published structure is patched from the new analysis.",
          "incremental",
          "patch",
        )
      : fullPlan(
          currentPageIds,
          removedPageIds,
          "A package was added or removed, the documentation configuration changed, or too many structural files changed.",
          "incremental",
          "regenerate",
        );
  }
  if (previous.structuralFingerprint !== input.structuralFingerprint) {
    return fullPlan(
      currentPageIds,
      removedPageIds,
      "The structural source fingerprint changed.",
      "incremental",
      "regenerate",
    );
  }

  if (
    previous.writingFingerprint !== undefined &&
    previous.writingFingerprint !== input.writingFingerprint
  ) {
    return rewritePlan(
      currentPageIds,
      removedPageIds,
      "The writer contract changed; existing analysis and structure remain reusable.",
      "incremental",
    );
  }

  const pagePlan = planPagesAgainstBaseline({
    currentPageIds,
    currentPageInputHashes: input.currentPageInputHashes,
    dependencyChangePaths: new Set(sourceChangePaths(relevantChanges)),
    previous,
    templatePageIds: input.templatePageIds,
  });

  if (pagePlan.regeneratePageIds.length === 0) {
    return fullPlan(
      currentPageIds,
      pagePlan.removedPageIds,
      "Documentation-relevant source changes are not mapped to prior page dependencies.",
      "incremental",
      "reuse",
    );
  }

  return {
    analysisMode: "incremental",
    structureMode: "reuse",
    ...pagePlan,
    modelCallsRequired: true,
  };
}

/** The most structural files that one patch covers. A larger change plans the structure again. */
export const MAX_STRUCTURE_PATCH_CHANGES = 20;

/**
 * True when structural changes can patch the published structure instead of
 * planning it again. Routes, schemas and edited package manifests change the
 * REST and SDK reference surfaces, which the patch rebuilds from analysis.
 * A new or removed package, a documentation configuration change, or a very
 * large change can need new editorial pages, so those plan again.
 */
export function canPatchStructure(changes: readonly RevisionSourceChange[]): boolean {
  if (changes.length > MAX_STRUCTURE_PATCH_CHANGES) return false;
  return changes.every((change) => {
    const paths = sourceChangePaths([change]);
    if (paths.some(isDocsConfigPath)) return false;
    return change.status === "modified" || !paths.some(isPackageManifestPath);
  });
}

export async function buildStructuralFingerprint(
  files: readonly { path: string; contentHash: string }[],
): Promise<string> {
  return hashValue(
    files
      .filter((file) => isStructuralSourcePath(file.path))
      .map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
      }))
      .sort((left, right) => compareStrings(left.path, right.path)),
  );
}

function fullPlan(
  currentPageIds: string[],
  removedPageIds: string[],
  reason: string,
  analysisMode: RevisionAwareGenerationPlan["analysisMode"] = "full",
  structureMode: RevisionAwareGenerationPlan["structureMode"] = "regenerate",
): RevisionAwareGenerationPlan {
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

function rewritePlan(
  currentPageIds: string[],
  removedPageIds: string[],
  reason: string,
  analysisMode: RevisionAwareGenerationPlan["analysisMode"] = "reuse",
): RevisionAwareGenerationPlan {
  return {
    analysisMode,
    structureMode: "reuse",
    regeneratePageIds: currentPageIds,
    reusePageIds: [],
    removedPageIds,
    modelCallsRequired: currentPageIds.length > 0,
    reasons: [reason],
  };
}

/** A regenerated page that the writer edits from its published version. */
export interface PageEdit {
  /** Where the published page is stored. */
  artifactKey: string;
  /** The changed files that the page depends on. Empty when only its brief changed. */
  changedSources: string[];
}

/**
 * The regenerated pages that the baseline already has, with the changed
 * files each one depends on, so the writer edits them instead of writing
 * them again. Only a page-level plan (one with `causes`) has edits: a plan
 * that rewrites every page, for example after a contract change, means it.
 */
export function planPageEdits(input: {
  plan: Pick<RevisionAwareGenerationPlan, "regeneratePageIds" | "causes">;
  previousPages: readonly { pageId: string; artifactKey: string; dependencies: PageDependencyState }[];
  /** The evidence file paths of each current page. */
  currentEvidencePaths: Readonly<Record<string, readonly string[]>>;
  changedPaths: ReadonlySet<string>;
  /** Pages that a template renders, which no writer edits. */
  templatePageIds?: ReadonlySet<string>;
}): Record<string, PageEdit> {
  if (!input.plan.causes) return {};
  const previousById = new Map(input.previousPages.map((page) => [page.pageId, page]));
  const edits: Record<string, PageEdit> = {};
  for (const pageId of input.plan.regeneratePageIds) {
    const previous = previousById.get(pageId);
    if (!previous || input.templatePageIds?.has(pageId)) continue;
    const sources = [
      ...dependencyPaths(previous.dependencies),
      ...(input.currentEvidencePaths[pageId] ?? []),
    ];
    edits[pageId] = {
      artifactKey: previous.artifactKey,
      changedSources: [...new Set(sources.filter((path) => input.changedPaths.has(path)))].sort(),
    };
  }
  return edits;
}

function dependencyPaths(dependencies: PageDependencyState): string[] {
  return [
    ...dependencies.sourceFilesRead,
    ...dependencies.sourceFilesDiscovered,
    ...dependencies.sourceEvidenceFiles,
  ];
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate page ID in incremental plan: ${value}`);
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function isPageDependencyState(
  value: unknown,
): value is PageDependencyState {
  if (!isRecord(value)) {
    return false;
  }
  return [
    "sourceFilesRead",
    "sourceFilesDiscovered",
    "sourceEvidenceFiles",
    "referencedSymbols",
    "referencedRoutes",
  ].every((key) =>
    key in value &&
    Array.isArray(value[key]) &&
    value[key].every(
      (item: unknown) => typeof item === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
