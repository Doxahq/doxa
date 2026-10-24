import type { ReferenceSourceReport } from "@doxahq/contracts"
import { describe, expect, test } from "vitest"

import { readReferenceSource, specProblemNotice } from "../src/lib/dashboard/reference-source"

const report = (overrides: Partial<ReferenceSourceReport>): ReferenceSourceReport => ({
  status: "openapi",
  specs: [{ path: "openapi.yaml", outcome: "parsed", specVersion: "3.1.0" }],
  operationCount: 4,
  skippedOperationCount: 0,
  redactedSecretCount: 0,
  ...overrides,
})

describe("API spec problems of a run", () => {
  test("shows nothing for a clean spec, no spec, or no report", () => {
    expect(specProblemNotice(report({}))).toBeNull()
    expect(specProblemNotice(report({ status: "no_spec", specs: [], operationCount: 0 }))).toBeNull()
    expect(specProblemNotice(null)).toBeNull()
    expect(readReferenceSource({})).toBeNull()
  })

  test("names a rejected spec with the line and the reason of its parse issue", () => {
    const message = "A line has the wrong indentation."
    const notice = specProblemNotice(report({
      status: "spec_rejected",
      specs: [{ path: "swagger.yaml", outcome: "rejected", code: "parse_failed", message }],
      fileIssues: [{ file: "swagger.yaml", reason: "yaml_bad_indent", message, line: 537, column: 9 }],
      operationCount: 0,
    }))

    expect(notice).toEqual({
      heading: "The API spec could not be used",
      summary: expect.stringContaining("built from the code instead"),
      problems: [{ path: "swagger.yaml", location: "Line 537, column 9", operation: null, message }],
      unlistedOperationCount: 0,
    })
  })

  test("lists referenced files that did not parse and refused files once each", () => {
    const notice = specProblemNotice(report({
      specs: [
        { path: "openapi.yaml", outcome: "parsed", specVersion: "3.1.0" },
        { path: "big/openapi.json", outcome: "refused", code: "too_large", message: "The file is larger than 25 MB." },
      ],
      fileIssues: [{ file: "schemas/order.yaml", reason: "yaml_duplicate_key", message: "A key appears twice in the same mapping.", line: 3 }],
    }))

    expect(notice?.heading).toBe("Some spec files could not be read")
    expect(notice?.problems).toEqual([
      { path: "big/openapi.json", location: null, operation: null, message: "The file is larger than 25 MB." },
      { path: "schemas/order.yaml", location: "Line 3", operation: null, message: "A key appears twice in the same mapping." },
    ])
  })

  test("lists skipped operations and counts those the report did not list", () => {
    const notice = specProblemNotice(report({
      status: "openapi_partial",
      skippedOperationCount: 52,
      skippedOperations: [
        { specPath: "openapi.yaml", method: "GET", path: "/orders", code: "unresolved_reference", message: "A reference points to nothing." },
      ],
    }))

    expect(notice).toMatchObject({
      heading: "52 API operations were left out",
      problems: [{ path: "openapi.yaml", operation: "GET /orders", message: "A reference points to nothing." }],
      unlistedOperationCount: 51,
    })
  })

  test("tells the user to run again when the reader did not answer", () => {
    expect(specProblemNotice(report({
      status: "reader_unavailable",
      specs: [{ path: "openapi.yaml", outcome: "unread", code: "reader_failed", message: "The spec reader did not answer." }],
      operationCount: 0,
    }))).toMatchObject({
      heading: "The API spec was not read",
      problems: [{ path: "openapi.yaml", message: "The spec reader did not answer." }],
    })
  })
})
