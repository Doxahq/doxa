import { run } from "../core";
import type {
  AgentSpanCallback,
  AgentUsageCallback,
  Provider,
} from "../core";
import type { AgentProgressCallback, DocumentationStructure, StructureSuggestionInput } from "../types";
import { applyCollectionsToStructure } from "../utils/documentation-collections";
import { prompts } from "./prompts";
import type { PromptRegistry } from "./prompts";
import { validateDocumentationStructureForProfile } from "./prompts/dynamic";
import { parseStructureResult } from "./json-parsing";
import { STRUCTURE_RESPONSE_SCHEMA } from "./response-schemas";
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

  try {
    const parsed = parseStructureResult(result.text);
    const modelDuplicates = validateGlobalPageIds(parsed);
    // The published structure keeps each reference page's route and name across runs.
    // A new plan may drop an old collision mark from a route; a patch never does.
    const structure = ensureReferenceSections(
      applyCollectionsToStructure(parsed, analysis),
      analysis,
      referenceSectionDefaultsFromAnswers(answers),
      input.publishedStructure,
      { dropCollisionMarks: true },
    );
    const injectedDuplicates = validateGlobalPageIds(structure);
    if (modelDuplicates.length === 0 && injectedDuplicates.length > 0) {
      throw new StructurePipelineDefectError(
        `Reference section injection introduced duplicate page IDs (${duplicatePageIds(injectedDuplicates)}). ` +
          "This is a defect in reference injection, not in the model output.",
      );
    }
    const preInjectionValidation = validateDocumentationStructureForProfile(parsed, analysis);
    const postInjectionValidation = validateDocumentationStructureForProfile(structure, analysis);
    const preInjectionErrors = new Set(preInjectionValidation.errors);
    const injectionOnlyErrors = postInjectionValidation.errors.filter(
      (error) => !preInjectionErrors.has(error),
    );
    if (injectedDuplicates.length === 0 && injectionOnlyErrors.length > 0) {
      throw new StructurePipelineDefectError(
        "Reference/collection injection introduced structure validation errors " +
          `(${injectionOnlyErrors.join("; ")}). This is a defect in injection, not in the model output.`,
      );
    }
    const validationErrors = [
      ...injectedDuplicates,
      ...postInjectionValidation.errors,
    ];
    if (validationErrors.length > 0) {
      throw new Error(
        `Structure validation failed: ${validationErrors.join("; ")}`,
      );
    }
    return structure;
  } catch (error) {
    abortController?.signal.throwIfAborted();
    if (error instanceof StructurePipelineDefectError) throw error;
    if (attempt < maxAttempts) {
      const nextValidationErrors = error instanceof Error
        ? [error.message]
        : ["Structure generation failed for an unknown reason."];
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
