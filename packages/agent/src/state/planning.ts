import type { DocumentationGenerationBrief, DocumentationStructure, ProjectAnalysis, ResolvedDocumentationGenerationBrief } from "../types";
import {
  documentationBriefFingerprint,
  NO_PROJECT_INSTRUCTIONS_FINGERPRINT,
  projectInstructionsFingerprint,
  resolveDocumentationBrief,
} from "../doxa-agent/documentation-policy";
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
  /** The project instructions of the published run. */
  projectInstructionsFingerprint?: string;
  structuralFingerprint: string;
  pages: Array<{
    pageId: string;
    pageInputHash: string;
    dependencies: PageDependencyState;
    /**
     * The project instructions that this page was written with. A page that
     * a run kept, for example a locked or failed page, keeps an older value.
     * Absent on pages stored before the field: they follow the published run.
     */
    projectInstructionsFingerprint?: string;
  }>;
  /**
   * Pages that runs no longer try to bring up to the published run's
   * instructions, from the site's catch-up ledger.
   */
  exhaustedCatchUpPageIds?: readonly string[];
}

/**
 * The project instructions fingerprint of a run. Instructions that ask for
 * nothing beyond a run without them count as none, the same value that the
 * API computes with `generationInstructionsFingerprint`.
 */
export function runInstructionsFingerprint(
  brief: ResolvedDocumentationGenerationBrief,
): string {
  return projectInstructionsFingerprint(brief);
}

/**
 * The published pages that an earlier run kept behind its own instructions,
 * because a person locked them or their rewrite failed. Only a run with the
 * published run's instructions catches them up: when the instructions change,
 * every page is written as part of the change, and none is a catch-up page.
 * A page that ran out of catch-up attempts is left out, so a page that always
 * fails cannot keep costing runs.
 */
export function pagesBehindInstructions(
  previous: PriorRevisionGenerationState | null,
  currentFingerprint: string | undefined,
): Set<string> {
  if (!previous || currentFingerprint === undefined) return new Set();
  if (runInstructionsChanged(previous, currentFingerprint)) return new Set();
  const runFingerprint = previous.projectInstructionsFingerprint ?? NO_PROJECT_INSTRUCTIONS_FINGERPRINT;
  const exhausted = new Set(previous.exhaustedCatchUpPageIds ?? []);
  return new Set(previous.pages
    .filter((page) =>
      (page.projectInstructionsFingerprint ?? runFingerprint) !== runFingerprint
      && !exhausted.has(page.pageId)
    )
    .map((page) => page.pageId));
}

/**
 * Moves the reused pages that are behind the instructions to the pages the
 * run writes, so a page kept through an instructions change catches up in a
 * later run. Template pages, which follow their inputs alone, stay reused.
 */
export function catchUpInstructionPages<TPlan extends RevisionAwareGenerationPlan>(input: {
  plan: TPlan;
  currentPageIds: readonly string[];
  behindPageIds: ReadonlySet<string>;
  templatePageIds?: ReadonlySet<string>;
}): TPlan {
  const caughtUp = new Set(input.plan.reusePageIds.filter((pageId) =>
    input.behindPageIds.has(pageId) && !input.templatePageIds?.has(pageId)
  ));
  if (caughtUp.size === 0) return input.plan;

  const regenerate = new Set([...input.plan.regeneratePageIds, ...caughtUp]);
  const catchUpPageIds = new Set([...(input.plan.catchUpPageIds ?? []), ...caughtUp]);
  return {
    ...input.plan,
    catchUpPageIds: input.currentPageIds.filter((pageId) => catchUpPageIds.has(pageId)),
    ...(input.plan.causes
      ? { causes: { ...input.plan.causes, instructionsChanged: (input.plan.causes.instructionsChanged ?? 0) + caughtUp.size } }
      : {}),
    regeneratePageIds: input.currentPageIds.filter((pageId) => regenerate.has(pageId)),
    reusePageIds: input.plan.reusePageIds.filter((pageId) => !caughtUp.has(pageId)),
    modelCallsRequired: true,
    reasons: [
      ...input.plan.reasons,
      `${caughtUp.size} page(s) were kept through an instructions change and now follow the current instructions.`,
    ],
  };
}

/**
 * The page edits that bring the given baseline pages up to the current
 * instructions, merged into the source edits of the plan.
 */
export function instructionCatchUpEdits(input: {
  pageIds: Iterable<string>;
  previousPages: readonly { pageId: string; artifactKey: string }[];
  edits: Readonly<Record<string, PageEdit>>;
  templatePageIds?: ReadonlySet<string>;
}): Record<string, PageEdit> {
  const previousById = new Map(input.previousPages.map((page) => [page.pageId, page]));
  const edits: Record<string, PageEdit> = { ...input.edits };
  for (const pageId of input.pageIds) {
    const previous = previousById.get(pageId);
    if (!previous || input.templatePageIds?.has(pageId)) continue;
    edits[pageId] = {
      artifactKey: previous.artifactKey,
      changedSources: input.edits[pageId]?.changedSources ?? [],
      instructionsChanged: true,
    };
  }
  return edits;
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

export interface RevisionAwarePlanInput {
  currentPageIds: readonly string[];
  currentPageInputHashes: Readonly<Record<string, string>>;
  changes: readonly RevisionSourceChange[];
  planningFingerprint: string;
  writingFingerprint: string;
  structuralFingerprint: string;
  /**
   * The project instructions of this run. A change from the published ones
   * rewrites everything. A previous state without the field had none.
   */
  projectInstructionsFingerprint?: string;
  previous: PriorRevisionGenerationState | null;
  /** Template-rendered pages, which follow their input hash only. */
  templatePageIds?: ReadonlySet<string>;
  /**
   * Files whose change is structural for this project beyond the name
   * rules, such as the spec files that its REST reference came from.
   */
  structuralPaths?: ReadonlySet<string>;
}

/**
 * The plan of a run against the published state. After the run-wide checks,
 * a page that an instructions change kept is written again (see
 * {@link catchUpInstructionPages}).
 */
export function planRevisionAwareGeneration(input: RevisionAwarePlanInput): RevisionAwareGenerationPlan {
  return catchUpInstructionPages({
    plan: planAgainstPublishedState(input),
    currentPageIds: uniqueInOrder(input.currentPageIds),
    behindPageIds: pagesBehindInstructions(input.previous, input.projectInstructionsFingerprint),
    templatePageIds: input.templatePageIds,
  });
}

function planAgainstPublishedState(input: RevisionAwarePlanInput): RevisionAwareGenerationPlan {
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
  const instructionsChanged = runInstructionsChanged(previous, input.projectInstructionsFingerprint);
  if (
    previous.planningFingerprint !== undefined &&
    previous.planningFingerprint !== input.planningFingerprint
  ) {
    const plan = fullPlan(
      currentPageIds,
      removedPageIds,
      "The documentation planning contract changed.",
    );
    // The structure is planned again either way, and its prompt must still
    // know that the instructions changed. The pages are written fresh: the
    // final plan edits nothing after a contract change.
    return instructionsChanged ? { ...plan, editReason: "instructions_changed" } : plan;
  }
  if (instructionsChanged) {
    // The instructions steer analysis, structure and writing, so every page
    // is planned again. The pages the baseline has are edited, not written
    // again, so they keep their text where the instructions ask nothing.
    return {
      ...fullPlan(currentPageIds, removedPageIds, "The project instructions changed."),
      editReason: "instructions_changed",
    };
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

/**
 * True when this run's project instructions differ from the published run's.
 * A state without the field had none.
 */
export function runInstructionsChanged(
  previous: Pick<PriorRevisionGenerationState, "projectInstructionsFingerprint"> | null,
  currentFingerprint: string | undefined,
): boolean {
  if (!previous || currentFingerprint === undefined) return false;
  return (previous.projectInstructionsFingerprint ?? NO_PROJECT_INSTRUCTIONS_FINGERPRINT) !== currentFingerprint;
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
  /** The project instructions changed, so the writer updates the page to follow them. */
  instructionsChanged?: boolean;
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

/**
 * The page plan after the project instructions changed. Every page that the
 * baseline has is edited from its published version, marked so the writer
 * updates it to follow the instructions: a page the plan would reuse moves
 * to the pages it writes. A page with source edits keeps its changed files.
 * New pages are written from the source. Template pages, which code renders
 * and no writer edits, are rendered again, because the instructions steer
 * them too, for example the order of request samples.
 */
export function applyInstructionEdits<TPlan extends RevisionAwareGenerationPlan>(input: {
  plan: TPlan;
  /** The page IDs of the new structure, in order. */
  currentPageIds: readonly string[];
  previousPages: readonly { pageId: string; artifactKey: string }[];
  edits: Readonly<Record<string, PageEdit>>;
  templatePageIds?: ReadonlySet<string>;
}): TPlan & { pageEdits: Record<string, PageEdit>; editReason: "instructions_changed" } {
  const previousById = new Map(input.previousPages.map((page) => [page.pageId, page]));
  const isTemplate = (pageId: string) => input.templatePageIds?.has(pageId) === true;
  const isEditable = (pageId: string) => previousById.has(pageId) && !isTemplate(pageId);
  const regenerate = new Set([
    ...input.plan.regeneratePageIds,
    ...input.plan.reusePageIds.filter((pageId) => isEditable(pageId) || isTemplate(pageId)),
  ]);

  const pageEdits: Record<string, PageEdit> = { ...input.edits };
  for (const pageId of regenerate) {
    const previous = previousById.get(pageId);
    if (!previous || !isEditable(pageId)) continue;
    pageEdits[pageId] = {
      artifactKey: previous.artifactKey,
      changedSources: input.edits[pageId]?.changedSources ?? [],
      instructionsChanged: true,
    };
  }

  const regeneratePageIds = input.currentPageIds.filter((pageId) => regenerate.has(pageId));
  const movedFromReuse = regeneratePageIds.length - input.plan.regeneratePageIds.length;
  return {
    ...input.plan,
    ...(input.plan.causes
      ? { causes: { ...input.plan.causes, instructionsChanged: (input.plan.causes.instructionsChanged ?? 0) + movedFromReuse } }
      : {}),
    regeneratePageIds,
    reusePageIds: input.plan.reusePageIds.filter((pageId) => !regenerate.has(pageId)),
    modelCallsRequired: input.plan.modelCallsRequired || regeneratePageIds.length > 0,
    reasons: ["The project instructions changed.", ...input.plan.reasons.filter((reason) => reason !== "The project instructions changed.")],
    pageEdits,
    editReason: "instructions_changed",
  };
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
