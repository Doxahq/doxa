import { describe, expect, test } from "vitest";
import { lineColumnAt } from "../src/document/parse-issues";
import { openapi, read } from "./helpers";

function fileIssues(files: Record<string, string>) {
  const output = read(files);
  if (output.status !== "read") throw new Error(`Expected a read result, got ${output.status}.`);
  return output.fileIssues;
}

describe("parse issues", () => {
  test("names a strict YAML error by its line and column, with no text of the file", () => {
    const text = [
      "swagger: '2.0'",
      "info: { title: Shop, version: '1' }",
      "paths: {}",
      "definitions:",
      "  Article:",
      "    properties:",
      "      refreshDate:",
      '        description: "Date of the last SECRET_TOKEN_123 refresh. May not match the date',
      '        when the publication updated it."',
    ].join("\n");

    const [issue] = fileIssues({ "swagger.yaml": text });

    expect(issue).toEqual({
      file: "swagger.yaml",
      code: "parse_failed",
      reason: "yaml_missing_char",
      line: 8,
      column: expect.any(Number),
    });
    expect(JSON.stringify(issue)).not.toContain("SECRET_TOKEN_123");
  });

  test.each([
    ["a duplicate key", "openapi: 3.1.0\npaths: {}\npaths: {}\n", "yaml_duplicate_key", 3],
    ["a tab indent", "openapi: 3.1.0\npaths:\n\t/a: {}\n", "yaml_tab_indent", 3],
    ["a second document", "openapi: 3.1.0\npaths: {}\n---\nx: 1\n", "yaml_multiple_documents", 3],
    ["an unknown tag", "openapi: 3.1.0\npaths: {}\nx: !include other.yaml\n", "yaml_unknown_tag", 3],
  ])("names %s", (_label, text, reason, line) => {
    expect(fileIssues({ "openapi.yaml": text })).toEqual([
      expect.objectContaining({ file: "openapi.yaml", code: "parse_failed", reason, line }),
    ]);
  });

  test.each([
    ["a trailing comma", '{\n  "openapi": "3.1.0",\n  "paths": {},\n}', "json_property_name", 4, 1],
    ["a missing comma", '{\n  "openapi": "3.1.0"\n  "paths": {}\n}', "json_missing_comma", 3, 3],
    ["an unterminated string", '{\n  "openapi": "3.1.0', "json_unterminated_string", 2, 20],
  ])("names %s in JSON by its line and column", (_label, text, reason, line, column) => {
    expect(fileIssues({ "openapi.json": text })).toEqual([{ file: "openapi.json", code: "parse_failed", reason, line, column }]);
  });

  test("leaves out the location when V8 gives none", () => {
    const [issue] = fileIssues({ "openapi.json": '{"openapi":"3.1.0","paths":{},"x":tru}' });

    expect(issue).toEqual({ file: "openapi.json", code: "parse_failed", reason: "json_unexpected_character" });
  });

  test("names a referenced file that fails, while the root spec is still read", () => {
    const output = read({
      "openapi.yaml": openapi(`  /orders:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "./order.yaml#/Order" }
  /health:
    get:
      responses: { "200": { description: OK } }`),
      "order.yaml": "Order:\n  type: object\n  type: string\n",
    });

    expect(output).toMatchObject({
      status: "read",
      specs: [{ outcome: "parsed", root: "openapi.yaml" }],
      fileIssues: [{ file: "order.yaml", reason: "yaml_duplicate_key", line: 3 }],
    });
  });

  test("reports no issues for files that parse", () => {
    expect(fileIssues({ "openapi.yaml": openapi("  /a: { get: { responses: { \"200\": { description: OK } } } }") })).toEqual([]);
  });
});

describe("line and column of an offset", () => {
  test.each([
    [0, { line: 1, column: 1 }],
    [3, { line: 1, column: 4 }],
    [4, { line: 2, column: 1 }],
    [9, { line: 3, column: 1 }],
    [99, { line: 3, column: 3 }],
  ])("offset %i", (offset, expected) => {
    expect(lineColumnAt("abc\ndefg\nhi", offset)).toEqual(expected);
  });
});
