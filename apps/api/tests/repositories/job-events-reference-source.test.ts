import { describe, expect, test } from "vitest";
import { generationDetailSchema } from "@doxahq/contracts";
import { referenceSourceFromEvents } from "../../src/repositories/job-events";

const rejectedReport = {
  status: "spec_rejected",
  specs: [{ path: "swagger.yaml", outcome: "rejected", code: "parse_failed", message: "A line has the wrong indentation." }],
  fileIssues: [{ file: "swagger.yaml", reason: "yaml_bad_indent", message: "A line has the wrong indentation.", line: 537, column: 9 }],
  operationCount: 0,
  skippedOperationCount: 0,
  redactedSecretCount: 0,
};

describe("REST reference report of a run", () => {
  test("takes the last analysis event that carries a readable report", () => {
    const openapi = { ...rejectedReport, status: "openapi", specs: [], fileIssues: undefined, operationCount: 3 };

    expect(referenceSourceFromEvents([
      { data: { referenceSource: rejectedReport } },
      { data: { referenceSource: openapi } },
      { data: { referenceSource: { status: "made_up" } } },
      { data: { analysisMode: "reuse" } },
      { data: null },
    ])).toMatchObject({ status: "openapi", operationCount: 3 });
  });

  test("is null when no analysis event carries one", () => {
    expect(referenceSourceFromEvents([{ data: { analysisMode: "full" } }, { data: null }])).toBeNull();
  });

  test("keeps the location of each spec issue in the generation detail", () => {
    const report = referenceSourceFromEvents([{ data: { referenceSource: rejectedReport } }]);

    expect(report?.fileIssues).toEqual([
      { file: "swagger.yaml", reason: "yaml_bad_indent", message: "A line has the wrong indentation.", line: 537, column: 9 },
    ]);
    expect(generationDetailSchema.shape.referenceSource.parse(undefined)).toBeNull();
  });
});
