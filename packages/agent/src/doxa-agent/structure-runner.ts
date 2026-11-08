import { run } from "../core";
import type {
  AgentSpanCallback,
  AgentUsageCallback,
  Provider,
} from "../core";
import type { AgentProgressCallback, DocumentationStructure, StructureSuggestionInput } from "../types";
import { applyCollectionsToStructure } from "../utils/documentation-collections";
import { plannedPageTitleErrors } from "../utils/page-title-rules";
import { prompts } from "./prompts";
import type { PromptRegistry } from "./prompts";
import { validateDocumentationStructureForProfile } from "./prompts/dynamic";
import { parseStructureResult } from "./json-parsing";
import { STRUCTURE_RESPONSE_SCHEMA } from "./response-schemas";
import {
  describeMissingPageTypes,
  describePlanRemovals,
  filterPlanByInstructions,
  pagesMissingPageType,
  withoutExcludedEvidenceInStructure,
  type PlanRemoval,
} from "./project-instructions";
import { applyReferenceInstructionsToStructure } from "./reference-instructions";
import { ensureReferenceSections, referenceSectionDefaultsFromAnswers } from "./reference-surfaces";
import { StructurePipelineDefectError } from "./structure-review-errors";
import { validateGlobalPageIds } from "./structure-utils";

export class StructureGenerationFailedError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number) {
    super(message);
    this.name = "StructureGenerationFailedError";
    this.attempts = attempts;
  }
}

/**
 * A plan that the planner can fix on a retry: its pages lack a declared type,
 * or the pages that the instructions removed left it invalid once code added
 * its pages. It is never a defect of the code that adds pages.
 */
class PlanNeedsRevisionError extends Error {
  /** The pages that the instructions removed from the plan that failed. */
  readonly removed: readonly PlanRemoval[];

  constructor(message: string, removed: readonly PlanRemoval[] = []) {
    super(message);
    this.name = "PlanNeedsRevisionError";
    this.removed = removed;
  }
}

/**
 * The plan with the pages that code adds: collection pages and reference
 * sections. The published structure keeps each reference page's route and
 * name across runs; a new plan may drop an old collision mark from a route.
 * With the API reference off, no reference page stays, echoed or injected.
 * Code-added pages take evidence from the analysis; none of it may come from
 * a "Do not document" path.
 */
function withCodeAddedPages(plan: DocumentationStructure, input: StructureSuggestionInput): DocumentationStructure {
  return withoutExcludedEvidenceInStructure(
    applyReferenceInstructionsToStructure(
      ensureReferenceSections(
        applyCollectionsToStructure(plan, input.analysis),
        input.analysis,
        referenceSectionDefaultsFromAnswers(input.answers),
        input.publishedStructure,
        { dropCollisionMarks: true },
      ),
      input.documentationBrief,
    ),
    input.documentationBrief,
  );
}

/** The validation errors that the code-added pages bring into a plan. */
function injectionOnlyErrorsOf(
  plan: DocumentationStructure,
  withAddedPages: DocumentationStructure,
  analysis: StructureSuggestionInput["analysis"],
): string[] {
  const before = new Set(validateDocumentationStructureForProfile(plan, analysis).errors);
  return validateDocumentationStructureForProfile(withAddedPages, analysis).errors.filter((error) => !before.has(error));
}

/**
 * True when none of the errors that code-added pages bring into the filtered
 * plan also appear when the same pages go into the model's unfiltered plan:
 * the removals, not the injection, left the plan short. Errors compare by
 * identity, without the counts they name, because the two plans have other
 * page counts. Null means that adding pages to the unfiltered plan failed
 * itself: that is evidence of an injection defect, so it never reads as the
 * removals' doing.
 */
export function areErrorsCausedByRemovals(
  filteredInjectionErrors: readonly string[],
  unfilteredInjectionErrors: readonly string[] | null,
): boolean {
  if (unfilteredInjectionErrors === null) return false;
  const unfiltered = new Set(unfilteredInjectionErrors.map(validationErrorIdentity));
  return filteredInjectionErrors.length > 0
    && filteredInjectionErrors.every((error) => !unfiltered.has(validationErrorIdentity(error)));
}

/** A validation error without the numbers it names, such as page counts. */
function validationErrorIdentity(error: string): string {
  return error.replace(/\d+/g, "#");
}

/** The injection-only errors of the model's unfiltered plan, or null when adding pages to it fails. */
function unfilteredInjectionErrors(
  modelPlan: DocumentationStructure,
  input: StructureSuggestionInput,
  analysis: StructureSuggestionInput["analysis"],
): string[] | null {
  try {
    return injectionOnlyErrorsOf(modelPlan, withCodeAddedPages(modelPlan, input), analysis);
  } catch {
    return null;
  }
}

/**
 * The model's plan without what the owner's instructions rule out. Pages
 * without a declared type go back to the planner while it has attempts left;
 * on the last one, their titles decide.
 */
function filterModelPlan(
  modelPlan: DocumentationStructure,
  input: StructureSuggestionInput,
  isLastAttempt: boolean,
): { structure: DocumentationStructure; removed: PlanRemoval[] } {
  const missingTypes = pagesMissingPageType(modelPlan, input.documentationBrief);
  if (missingTypes.length > 0 && !isLastAttempt) {
    throw new PlanNeedsRevisionError(describeMissingPageTypes(missingTypes));
  }
  return filterPlanByInstructions(modelPlan, input.documentationBrief);
}

function duplicatePageIds(errors: string[]): string {
  return errors
    .map((error) => error.match(/Duplicate stable page ID "([^"]+)"/)?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => JSON.stringify(id))
    .join(", ");
}

export async function generateStructureWithRetry(
  provider: Provider,
  input: StructureSuggestionInput,
  onProgress?: AgentProgressCallback,
  attempt: number = 1,
  validationErrors: string[] = [],
  promptRegistry: PromptRegistry = prompts,
  abortController?: AbortController,
  onUsage?: AgentUsageCallback,
  onSpan?: AgentSpanCallback,
  modelCallTimeoutMs?: number,
  modelCallMaxDurationMs?: number,
): Promise<DocumentationStructure> {
  const maxAttempts = 3;
  const { analysis, answers } = input;
  const prompt = promptRegistry.buildStructurePrompt({
    analysis,
    answers,
    documentationBrief: input.documentationBrief,
    publishedStructure: input.publishedStructure,
    changedFiles: input.changedSourcePaths,
    instructionsChanged: input.instructionsChanged,
    attempt,
    validationErrors,
    maxPages: input.maxPages,
  });

  const result = await run(
    {
      provider,
      systemPrompt: prompt.system,
      responseFormat: "json",
      responseSchema: STRUCTURE_RESPONSE_SCHEMA,
      abortController,
      modelCallTimeoutMs,
      modelCallMaxDurationMs,
      usageContext: { operation: "structure", attempt },
      onUsage,
      onSpan,
    },
    prompt.user
  );

  onProgress?.({ stage: "proposing", message: "Parsing structure...", progress: 85 });

  let removedByInstructions: PlanRemoval[] = [];
  try {
    const modelPlan = parseStructureResult(result.text);
    const filtered = filterModelPlan(modelPlan, input, attempt >= maxAttempts);
    removedByInstructions = filtered.removed;
    const parsed = filtered.structure;
    const modelDuplicates = validateGlobalPageIds(parsed);
    const structure = withCodeAddedPages(parsed, input);
    const injectedDuplicates = validateGlobalPageIds(structure);
    if (modelDuplicates.length === 0 && injectedDuplicates.length > 0) {
      throw new StructurePipelineDefectError(
        `Reference section injection introduced duplicate page IDs (${duplicatePageIds(injectedDuplicates)}). ` +
          "This is a defect in reference injection, not in the model output.",
      );
    }
    const postInjectionValidation = validateDocumentationStructureForProfile(structure, analysis);
    const injectionOnlyErrors = injectionOnlyErrorsOf(parsed, structure, analysis);
    // Errors that code-added pages cause only once the filter removed pages
    // (for example a plan left without its Documentation section) go back to
    // the planner with the removed pages. An error that injection causes in
    // the unfiltered plan too stays a defect.
    if (
      injectedDuplicates.length === 0 &&
      removedByInstructions.length > 0 &&
      injectionOnlyErrors.length > 0 &&
      areErrorsCausedByRemovals(injectionOnlyErrors, unfilteredInjectionErrors(modelPlan, input, analysis))
    ) {
      throw new PlanNeedsRevisionError(
        `Structure validation failed: ${injectionOnlyErrors.join("; ")}`,
        removedByInstructions,
      );
    }
    if (injectedDuplicates.length === 0 && injectionOnlyErrors.length > 0) {
      throw new StructurePipelineDefectError(
        "Reference/collection injection introduced structure validation errors " +
          `(${injectionOnlyErrors.join("; ")}). This is a defect in injection, not in the model output.`,
      );
    }
    // A long title costs a retry, never the run: the last attempt keeps it.
    const titleErrors = attempt < maxAttempts ? plannedPageTitleErrors(parsed) : [];
    const validationErrors = [
      ...injectedDuplicates,
      ...postInjectionValidation.errors,
      ...titleErrors,
    ];
    if (validationErrors.length > 0) {
      throw new Error(
        `Structure validation failed: ${validationErrors.join("; ")}`,
      );
    }
    input.onPlanRemovals?.(removedByInstructions);
    return structure;
  } catch (error) {
    abortController?.signal.throwIfAborted();
    if (error instanceof StructurePipelineDefectError) throw error;
    if (attempt < maxAttempts) {
      const removalNote = describePlanRemovals(
        error instanceof PlanNeedsRevisionError ? error.removed : removedByInstructions,
      );
      const nextValidationErrors = [
        error instanceof Error ? error.message : "Structure generation failed for an unknown reason.",
        ...(removalNote ? [removalNote] : []),
      ];
      onProgress?.({
        stage: "proposing",
        message: `Retrying structure generation (attempt ${attempt + 1}/${maxAttempts})...`,
        progress: 50,
      });
      return generateStructureWithRetry(
        provider,
        input,
        onProgress,
        attempt + 1,
        nextValidationErrors,
        promptRegistry,
        abortController,
        onUsage,
        onSpan,
        modelCallTimeoutMs,
        modelCallMaxDurationMs,
      );
    }
    const message = error instanceof Error
      ? error.message
      : "Structure generation failed for an unknown reason.";
    throw new StructureGenerationFailedError(message, maxAttempts);
  }
}
