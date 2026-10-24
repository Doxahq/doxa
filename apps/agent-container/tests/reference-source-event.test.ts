import type { ReferenceSourceReport } from "@doxahq/agent";
import { describe, expect, test } from "vitest";
import { referenceSourceLogEvent } from "../src/reference-source-event";

const report = (overrides: Partial<ReferenceSourceReport>): ReferenceSourceReport => ({
  status: "openapi",
  specs: [{ path: "openapi.yaml", outcome: "parsed", specVersion: "3.1.0" }],
  operationCount: 612,
  skippedOperationCount: 0,
  redactedSecretCount: 0,
  ...overrides,
});

describe("API reference source log line", () => {
  test("names the spec, its version and the endpoint count", () => {
    expect(referenceSourceLogEvent(report({}))).toEqual({
      type: "api_reference_source",
      message: "Read the OpenAPI spec openapi.yaml (OpenAPI 3.1.0): 612 endpoints.",
      data: { status: "openapi", specs: "openapi.yaml", endpoints: 612, skipped: 0, fileIssues: 0 },
    });
  });

  test("names a Swagger 2.0 spec as Swagger", () => {
    expect(referenceSourceLogEvent(report({
      specs: [{ path: "swagger.yaml", outcome: "parsed", specVersion: "2.0" }],
      operationCount: 1,
    })).message).toBe("Read the OpenAPI spec swagger.yaml (Swagger 2.0): 1 endpoint.");
  });

  test("counts several specs, left-out operations, unused files and parse issues", () => {
    const line = referenceSourceLogEvent(report({
      status: "openapi_partial",
      specs: [
        { path: "a.yaml", outcome: "parsed", specVersion: "3.1.0" },
        { path: "b.yaml", outcome: "parsed", specVersion: "3.0.3" },
        { path: "c.yaml", outcome: "parsed", specVersion: "3.0.3" },
        { path: "d.yaml", outcome: "parsed", specVersion: "3.0.3" },
        { path: "big.json", outcome: "refused", code: "too_large" },
      ],
      operationCount: 1_200,
      skippedOperationCount: 2,
      fileIssues: [{ file: "schemas/order.yaml", reason: "yaml_bad_indent", message: "Bad.", line: 4 }],
    }));

    expect(line.message).toBe(
      "Read 4 OpenAPI specs (a.yaml, b.yaml, c.yaml and 1 more): 1,200 endpoints. 2 operations were left out. 1 other spec file could not be used. 1 file did not parse.",
    );
    expect(line.data).toEqual({ status: "openapi_partial", specs: "a.yaml, b.yaml, c.yaml and 2 more", endpoints: 1_200, skipped: 2, fileIssues: 1 });
  });

  test("says that the code was used when there is no spec", () => {
    expect(referenceSourceLogEvent(report({ status: "no_spec", specs: [], operationCount: 0 }))).toMatchObject({
      message: "No OpenAPI spec found. The REST reference comes from the code.",
      data: { status: "no_spec", specs: "none", endpoints: 0 },
    });
  });

  test("names a spec that could not be used", () => {
    expect(referenceSourceLogEvent(report({
      status: "spec_rejected",
      specs: [{ path: "swagger-spec.yaml", outcome: "rejected", code: "parse_failed" }],
      operationCount: 0,
    })).message).toBe("The OpenAPI spec swagger-spec.yaml could not be used. The REST reference comes from the code.");
    expect(referenceSourceLogEvent(report({
      status: "spec_rejected",
      specs: [{ path: "a.yaml", outcome: "rejected", code: "no_paths" }, { path: "b.json", outcome: "refused", code: "too_large" }],
      operationCount: 0,
    })).message).toBe("2 OpenAPI specs (a.yaml, b.json) could not be used. The REST reference comes from the code.");
  });

  test("says that the reader did not run", () => {
    expect(referenceSourceLogEvent(report({
      status: "reader_unavailable",
      specs: [{ path: "openapi.yaml", outcome: "unread", code: "reader_failed" }],
      operationCount: 0,
    })).message).toBe("The OpenAPI spec reader did not run for openapi.yaml. The REST reference comes from the code.");
  });
});
