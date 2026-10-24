export type StructureFailureKind =
  | "model_output"
  | "pipeline_defect"
  | "infeasible_constraints";

export class StructurePipelineDefectError extends Error {
  readonly kind = "pipeline_defect" as const satisfies StructureFailureKind;

  constructor(message: string) {
    super(message);
    this.name = "StructurePipelineDefectError";
  }
}

export class StructureInfeasibleConstraintsError extends Error {
  readonly kind = "infeasible_constraints" as const satisfies StructureFailureKind;

  constructor(message: string) {
    super(message);
    this.name = "StructureInfeasibleConstraintsError";
  }
}
