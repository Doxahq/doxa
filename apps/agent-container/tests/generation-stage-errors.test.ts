import { describe, expect, test } from "vitest";
import { StructurePipelineDefectError } from "@doxahq/agent";
import { ModelCallError } from "@doxahq/agent";
import { classifyGenerationStageError } from "../src/generation-stage-errors";

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("generation stage error classification", () => {
  test("marks exhausted deterministic generation validation as non-retryable", () => {
    expect(classifyGenerationStageError(
      namedError(
        "DocsQualityValidationError",
        "Generated docs failed quality validation.",
      ),
    )).toEqual({
      message: "Generated docs failed quality validation.",
      retryable: false,
      code: "docs_quality_validation_failed",
    });

    expect(classifyGenerationStageError(
      namedError("StructureReviewFailedError", "Reviewed structure is invalid."),
    )).toEqual({
      message: "Reviewed structure is invalid.",
      retryable: false,
      code: "structure_review_failed",
    });
  });

  test("distinguishes structure pipeline defects from infeasible constraints", () => {
    expect(classifyGenerationStageError(
      new StructurePipelineDefectError(
        "Generated reference page title does not survive frontmatter sanitization.",
      ),
    )).toEqual({
      message: "Generated reference page title does not survive frontmatter sanitization.",
      retryable: false,
      code: "structure_pipeline_defect",
    });

    expect(classifyGenerationStageError(
      namedError(
        "StructureInfeasibleConstraintsError",
        "Mandatory documentation pages exceed the configured ceiling.",
      ),
    )).toEqual({
      message: "Mandatory documentation pages exceed the configured ceiling.",
      retryable: false,
      code: "structure_infeasible_constraints",
    });
  });

  test("keeps transient infrastructure failures retryable", () => {
    expect(classifyGenerationStageError(
      new Error("Failed to connect to github.com port 443."),
    )).toEqual({
      message: "Failed to connect to github.com port 443.",
      retryable: true,
      code: "generation_stage_failed",
    });
  });

  test("a spend cap or a bad key stops the stage without a retry", () => {
    const spendCap = new ModelCallError("spend_cap", "Your credit balance is too low", 400);
    expect(classifyGenerationStageError(spendCap)).toEqual({
      message: spendCap.message,
      retryable: false,
      code: "model_provider_spend_cap",
    });
    expect(classifyGenerationStageError(new ModelCallError("overloaded", "Overloaded", 529)))
      .toMatchObject({ retryable: true, code: "generation_stage_failed" });
  });
});
