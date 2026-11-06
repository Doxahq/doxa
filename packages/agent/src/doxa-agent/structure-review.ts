import { z } from "zod";
import { run } from "../core";
import type {
  AgentSpanCallback,
  AgentUsageCallback,
  Provider,
} from "../core";
import type {
  AgentConfig,
  AgentProgressCallback,
  DocPage,
  DocumentationGenerationBrief,
  DocumentationStructure,
  ProjectAnalysis,
  SourceEvidence,
} from "../types";
import { createProviderFromConfig } from "./provider-factory";
import { prompts } from "./prompts";
import type { PromptRegistry } from "./prompts";
import { validateDocumentationStructureForProfile } from "./prompts/dynamic";
import { responseSchemaFromZod } from "./response-schemas";
import { slugify, validateGlobalPageIds } from "./structure-utils";
import { isTemplateRenderedPage } from "./page-renderer-kind";
import {
  StructureInfeasibleConstraintsError,
  StructurePipelineDefectError,
} from "./structure-review-errors";

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep"), pageId: z.string().min(1), reason: z.string().min(1) }),
  z.object({
    action: z.literal("merge"),
    pageId: z.string().min(1),
    targetPageId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal("move"),
    pageId: z.string().min(1),
    targetSectionId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({ action: z.literal("drop"), pageId: z.string().min(1), reason: z.string().min(1) }),
]);

const reviewSchema = z.object({ decisions: z.array(decisionSchema).min(1) });

export const STRUCTURE_REVIEW_RESPONSE_SCHEMA = responseSchemaFromZod("structure_review", reviewSchema);

export type StructureReviewDecision = z.infer<typeof decisionSchema>;

export interface StructureReviewDecisionSummary {
  keepCount: number;
  mergeCount: number;
  moveCount: number;
  dropCount: number;
}

export interface StructureReviewInput {
  analysis: ProjectAnalysis;
  structure: DocumentationStructure;
  /** Editorial budget for guide, concept, and workflow pages. */
  maxPages: number;
  documentationBrief?: DocumentationGenerationBrief;
  publishedStructure?: DocumentationStructure;
  changedSourcePaths?: string[];
  /** The project instructions changed since the published structure. */
  instructionsChanged?: boolean;
  onDegraded?: (unresolvedErrors: string[]) => void | Promise<void>;
}

export class StructureReviewFailedError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number) {
    super(message);
    this.name = "StructureReviewFailedError";
    this.attempts = attempts;
  }
}

export function summarizeStructureReviewDecisions(
  decisions: readonly StructureReviewDecision[],
): StructureReviewDecisionSummary {
  return {
    keepCount: decisions.filter((decision) => decision.action === "keep").length,
    mergeCount: decisions.filter((decision) => decision.action === "merge").length,
    moveCount: decisions.filter((decision) => decision.action === "move").length,
    dropCount: decisions.filter((decision) => decision.action === "drop").length,
  };
}

interface LocatedPage {
  pageId: string;
  sectionId: string;
  page: DocPage;
}

function locatePages(structure: DocumentationStructure): LocatedPage[] {
  return structure.sections.flatMap((section) => section.pages.map((page) => ({
    pageId: `${section.id}/${page.id}`,
    sectionId: section.id,
    page,
  })));
}

function uniqueEvidence(items: SourceEvidence[]): SourceEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.path || seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

function mergePages(target: DocPage, source: DocPage): DocPage {
  return {
    ...target,
    description: mergePageBrief(target, source),
    sourceEvidence: uniqueEvidence([
      ...(target.sourceEvidence ?? []),
      ...(source.sourceEvidence ?? []),
    ]),
  };
}

/**
 * The brief of a page that takes in another page: its own description, whole,
 * then a note to cover the merged topic. The writer shortens the published
 * description itself, so the brief is never cut.
 */
function mergePageBrief(target: DocPage, source: DocPage): string {
  const base = target.description.trim().replace(/\s+/g, " ");
  const topic = source.title.trim();
  return topic ? `${base} Include ${topic} within this same reader workflow.` : base;
}

/**
 * Applies the review decisions. Template-rendered pages are fixed by the API
 * surface: they need no decision, keep their place, and accept only `keep`.
 */
export function applyStructureReviewDecisions(
  structure: DocumentationStructure,
  decisions: readonly StructureReviewDecision[],
): DocumentationStructure {
  const locatedPages = locatePages(structure);
  const pageById = new Map(locatedPages.map((entry) => [entry.pageId, entry]));
  const decisionById = new Map<string, StructureReviewDecision>();

  for (const decision of decisions) {
    if (decisionById.has(decision.pageId)) {
      throw new Error(`Structure review contains multiple decisions for page ${decision.pageId}.`);
    }
    const located = pageById.get(decision.pageId);
    if (!located) {
      throw new Error(`Structure review page ${decision.pageId} does not exist.`);
    }
    if (isTemplateRenderedPage(located.page) && decision.action !== "keep") {
      throw new Error(`Structure review cannot ${decision.action} the fixed reference page ${decision.pageId}.`);
    }
    decisionById.set(decision.pageId, decision);
  }
  const undecidedPage = locatedPages.find((entry) =>
    !isTemplateRenderedPage(entry.page) && !decisionById.has(entry.pageId)
  );
  if (undecidedPage) {
    throw new Error("Structure review must provide exactly one decision for every page.");
  }

  const sectionIds = new Set(structure.sections.map((section) => section.id));
  for (const decision of decisions) {
    if (decision.action === "merge") {
      if (decision.targetPageId === decision.pageId) {
        throw new Error(`Merge target for ${decision.pageId} cannot be the same page.`);
      }
      const target = pageById.get(decision.targetPageId);
      if (!target) {
        throw new Error(`Merge target ${decision.targetPageId} does not exist.`);
      }
      if (isTemplateRenderedPage(target.page)) {
        throw new Error(`Merge target ${decision.targetPageId} is a fixed reference page.`);
      }
      const targetDecision = decisionById.get(decision.targetPageId);
      if (targetDecision?.action === "drop" || targetDecision?.action === "merge") {
        throw new Error(`Merge target ${decision.targetPageId} must be kept or moved.`);
      }
    }
    if (decision.action === "move" && !sectionIds.has(decision.targetSectionId)) {
      throw new Error(`Move target section ${decision.targetSectionId} does not exist.`);
    }
  }

  const resolvedPages = new Map(locatedPages.map((entry) => [entry.pageId, entry.page]));
  for (const decision of decisions) {
    if (decision.action !== "merge") continue;
    const source = resolvedPages.get(decision.pageId);
    const target = resolvedPages.get(decision.targetPageId);
    if (source && target) resolvedPages.set(decision.targetPageId, mergePages(target, source));
  }

  const pagesBySection = new Map<string, DocPage[]>();
  for (const section of structure.sections) pagesBySection.set(section.id, []);
  for (const entry of locatedPages) {
    const decision = decisionById.get(entry.pageId) ??
      { action: "keep", pageId: entry.pageId, reason: "Fixed by the API surface." };
    if (decision.action === "drop" || decision.action === "merge") continue;
    const sectionId = decision.action === "move" ? decision.targetSectionId : entry.sectionId;
    pagesBySection.get(sectionId)?.push(resolvedPages.get(entry.pageId) ?? entry.page);
  }

  const nonEmptySections = structure.sections
    .map((section) => ({ ...section, pages: pagesBySection.get(section.id) ?? [] }))
    .filter((section) => section.pages.length > 0);
  if (nonEmptySections.length === 0) {
    throw new Error("Structure review removed every documentation page.");
  }
  const defaultIndex = nonEmptySections.findIndex((section) => section.default === true);
  const normalizedSections = nonEmptySections.map((section, index) => ({
    ...section,
    ...(defaultIndex === -1 && index === 0 ? { default: true } : {}),
  }));

  return { sections: normalizedSections };
}

export interface StructureReviewOperations {
  applyDecisions(
    structure: DocumentationStructure,
    decisions: readonly StructureReviewDecision[],
  ): DocumentationStructure;
}

const DEFAULT_STRUCTURE_REVIEW_OPERATIONS: StructureReviewOperations = {
  applyDecisions: applyStructureReviewDecisions,
};

function duplicateStablePageIds(errors: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const error of errors) {
    const match = error.match(/Duplicate stable page ID "([^"]+)"/);
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}

function assertDecisionApplicationPreservesPageIds(
  inputDuplicateErrors: readonly string[],
  reviewed: DocumentationStructure,
): void {
  if (inputDuplicateErrors.length > 0) return;

  const reviewedDuplicateErrors = validateGlobalPageIds(reviewed);
  if (reviewedDuplicateErrors.length === 0) return;

  const duplicateIds = duplicateStablePageIds(reviewedDuplicateErrors);
  const collisions = duplicateIds.length > 0
    ? duplicateIds.join(", ")
    : reviewedDuplicateErrors.join("; ");
  throw new StructurePipelineDefectError(
    `Structure review decision application introduced duplicate page IDs (${collisions}). ` +
      "This is a defect in decision application, not in the model output.",
  );
}

export function editorialPageCount(structure: DocumentationStructure): number {
  return structure.sections.reduce((total, section) =>
    total + section.pages.reduce((pageTotal, page) => {
      if (page.reference || page.collectionId) return pageTotal;
      return pageTotal + 1;
    }, 0), 0);
}

export function assertReviewFeasible(structure: DocumentationStructure): void {
  const defaultSectionCount = structure.sections.filter(
    (section) => section.default === true,
  ).length;
  if (defaultSectionCount !== 1) {
    throw new StructureInfeasibleConstraintsError(
      "Structure review requires exactly one default section before model review; " +
        `received ${defaultSectionCount}. Review decisions cannot change section default flags.`,
    );
  }
}

function semanticTitle(title: string): string {
  const ignored = new Set(["doc", "docs", "documentation", "file", "files", "guide", "guides"]);
  return slugify(title).split("-").filter((token) => !ignored.has(token)).join("-");
}

export function validateReviewedStructure(
  structure: DocumentationStructure,
  maxPages: number,
  analysis?: ProjectAnalysis,
  inputStructure?: DocumentationStructure,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const editorialCount = editorialPageCount(structure);
  if (editorialCount > maxPages) {
    errors.push(`Reviewed structure has ${editorialCount} editorial pages; editorial budget is ${maxPages}.`);
  }
  if (structure.sections.length === 0) errors.push("Reviewed structure has no sections.");
  if (structure.sections.some((section) => section.pages.length === 0)) {
    errors.push("Reviewed structure contains an empty section.");
  }
  if (structure.sections.filter((section) => section.default === true).length !== 1) {
    errors.push("Reviewed structure must have exactly one default section.");
  }
  errors.push(...validateGlobalPageIds(structure));

  const titleOwners = new Map<string, string>();
  for (const entry of locatePages(structure)) {
    const key = semanticTitle(entry.page.title);
    const existing = titleOwners.get(key);
    if (key && existing) errors.push(`Semantically duplicate pages remain: ${existing} and ${entry.pageId}.`);
    else if (key) titleOwners.set(key, entry.pageId);
  }

  if (analysis) {
    errors.push(...validateDocumentationStructureForProfile(structure, analysis, {
      stage: "review",
      inputStructure,
    }).errors);
  }

  return { valid: errors.length === 0, errors };
}

function parseReviewResult(text: string): StructureReviewDecision[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown JSON error";
    throw new Error(`Structure review returned invalid JSON: ${message}`);
  }
  const result = reviewSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Structure review response is invalid: ${z.prettifyError(result.error)}`);
  }
  return result.data.decisions;
}

function hasOnlyBudgetErrors(errors: readonly string[]): boolean {
  return errors.length > 0 && errors.every((error) =>
    /^Reviewed structure has \d+ editorial pages; editorial budget is \d+\.$/.test(error),
  );
}

export async function reviewStructureWithRetry(
  provider: Provider,
  input: StructureReviewInput,
  onProgress?: AgentProgressCallback,
  promptRegistry: PromptRegistry = prompts,
  abortController?: AbortController,
  onDecisions?: (summary: StructureReviewDecisionSummary) => void,
  onUsage?: AgentUsageCallback,
  onSpan?: AgentSpanCallback,
  modelCallTimeoutMs?: number,
  modelCallMaxDurationMs?: number,
  operations: StructureReviewOperations = DEFAULT_STRUCTURE_REVIEW_OPERATIONS,
): Promise<DocumentationStructure> {
  const maxAttempts = 3;
  let validationErrors: string[] = [];
  let parsedReviewOutput = false;
  let lastBudgetOnlyCandidate: DocumentationStructure | undefined;
  let lastBudgetOnlyErrors: string[] = [];

  assertReviewFeasible(input.structure);
  const inputDuplicateErrors = validateGlobalPageIds(input.structure);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = promptRegistry.buildStructureReviewPrompt({
      analysis: input.analysis,
      structure: input.structure,
      documentationBrief: input.documentationBrief,
      publishedStructure: input.publishedStructure,
      changedFiles: input.changedSourcePaths,
      instructionsChanged: input.instructionsChanged,
      maxPages: input.maxPages,
      attempt,
      validationErrors,
    });
    const result = await run(
      {
        provider,
        systemPrompt: prompt.system,
        responseFormat: "json",
        responseSchema: STRUCTURE_REVIEW_RESPONSE_SCHEMA,
        abortController,
        modelCallTimeoutMs,
        modelCallMaxDurationMs,
        usageContext: { operation: "structure_review", attempt },
        onUsage,
        onSpan,
      },
      prompt.user,
    );

    try {
      const decisions = parseReviewResult(result.text);
      parsedReviewOutput = true;
      const reviewed = operations.applyDecisions(input.structure, decisions);
      assertDecisionApplicationPreservesPageIds(inputDuplicateErrors, reviewed);
      const validation = validateReviewedStructure(
        reviewed,
        input.maxPages,
        input.analysis,
        input.structure,
      );
      if (!validation.valid) {
        if (hasOnlyBudgetErrors(validation.errors)) {
          lastBudgetOnlyCandidate = reviewed;
          lastBudgetOnlyErrors = validation.errors;
        }
        throw new Error(validation.errors.join("; "));
      }
      onDecisions?.(summarizeStructureReviewDecisions(decisions));
      return reviewed;
    } catch (error) {
      abortController?.signal.throwIfAborted();
      if (error instanceof StructurePipelineDefectError) throw error;
      validationErrors = [error instanceof Error ? error.message : "Unknown structure review failure."];
      if (attempt < maxAttempts) {
        onProgress?.({
          stage: "proposing",
          message: `Retrying structure review with validation feedback (attempt ${attempt + 1}/${maxAttempts})...`,
          progress: 90,
        });
      }
    }
  }

  const degradedStructure = lastBudgetOnlyCandidate ?? (parsedReviewOutput ? input.structure : undefined);
  if (degradedStructure) {
    const unresolvedErrors = lastBudgetOnlyErrors.length > 0
      ? lastBudgetOnlyErrors
      : validationErrors;
    await input.onDegraded?.(unresolvedErrors);
    return degradedStructure;
  }

  throw new StructureReviewFailedError(validationErrors[0] ?? "Structure review failed.", maxAttempts);
}

type AgentConfigWithInternalPrompts = AgentConfig & { promptRegistry?: PromptRegistry };

export async function reviewDocumentationStructure(
  config: AgentConfig,
  input: StructureReviewInput,
  onProgress?: AgentProgressCallback,
  onDecisions?: (summary: StructureReviewDecisionSummary) => void,
): Promise<DocumentationStructure> {
  const promptRegistry = (config as AgentConfigWithInternalPrompts).promptRegistry ?? prompts;
  return reviewStructureWithRetry(
    createProviderFromConfig(config),
    input,
    onProgress,
    promptRegistry,
    config.abortController,
    onDecisions,
    config.onModelUsage,
    config.onSpan,
    config.modelCallTimeoutMs,
    config.modelCallMaxDurationMs,
  );
}
