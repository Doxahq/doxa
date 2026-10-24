import { ModelCallError } from "@doxahq/agent";

export interface GenerationStageErrorClassification {
  message: string;
  retryable: boolean;
  code: string;
}

export class GenerationStageInvariantError extends Error {
  readonly code: string;

  constructor(message: string, code = "generation_stage_invariant_failed") {
    super(message);
    this.name = "GenerationStageInvariantError";
    this.code = code;
  }
}

const NON_RETRYABLE_ERROR_CODES: Readonly<Record<string, string>> = {
  DocsQualityValidationError: "docs_quality_validation_failed",
  StructureGenerationFailedError: "structure_generation_failed",
  StructureInfeasibleConstraintsError: "structure_infeasible_constraints",
  StructurePipelineDefectError: "structure_pipeline_defect",
  StructureReviewFailedError: "structure_review_failed",
  PageGenerationAbortedError: "page_generation_validation_failed",
  PageValidationExhaustedError: "page_generation_validation_failed",
  TestPageGenerationError: "page_generation_validation_failed",
};

export function classifyGenerationStageError(
  error: unknown,
): GenerationStageErrorClassification {
  const message = error instanceof Error
    ? error.message
    : "Generation stage failed";

  if (error instanceof GenerationStageInvariantError) {
    return { message, retryable: false, code: error.code };
  }
  // The provider refused the account or the model: a retry fails the same way.
  if (error instanceof ModelCallError && error.stopsRun) {
    return { message, retryable: false, code: `model_provider_${error.errorClass}` };
  }
  const nonRetryableCode = error instanceof Error
    ? NON_RETRYABLE_ERROR_CODES[error.name]
    : undefined;
  if (nonRetryableCode) {
    return {
      message,
      retryable: false,
      code: nonRetryableCode,
    };
  }

  return {
    message,
    retryable: true,
    code: "generation_stage_failed",
  };
}
