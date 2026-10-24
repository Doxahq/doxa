import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpecReaderInput, SpecReaderOutput } from "@doxahq/contracts/spec-reader";
import { afterEach, describe, expect, test } from "vitest";
import { checkSpecReaderOutput } from "../../src/reference-specs/output-schema";
import { readRepositorySpecs } from "../../src/reference-specs/reader";
import type { SpecReaderCallResult, SpecReaderClient } from "../../src/types";
import { parsedSpec, READER_VERSION } from "./fixtures";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doxa-spec-reader-"));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function fakeClient(answers: Array<SpecReaderCallResult | ((input: SpecReaderInput) => SpecReaderCallResult)>) {
  const inputs: SpecReaderInput[] = [];
  let doneCalls = 0;
  const client: SpecReaderClient = {
    async read(input) {
      inputs.push(input);
      const answer = answers.shift();
      if (!answer) throw new Error("No answer left.");
      return typeof answer === "function" ? answer(input) : answer;
    },
    async done() {
      doneCalls += 1;
    },
  };
  return { client, inputs, doneCalls: () => doneCalls };
}

const read = (output: SpecReaderOutput): SpecReaderCallResult => ({ ok: true, output });

describe("spec route reader", () => {
  test("reports no spec when the checkout has none", async () => {
    const root = await checkout({ "README.md": "# Shop" });

    await expect(readRepositorySpecs({ checkoutRoot: root })).resolves.toEqual({
      report: { status: "no_spec", specs: [], operationCount: 0, skippedOperationCount: 0, redactedSecretCount: 0 },
    });
  });

  test("sends needed files in a next round and builds the surface", async () => {
    const root = await checkout({
      "openapi.yaml": "openapi: 3.1.0\npaths: {}\n",
      "schemas/order.yaml": "Order: { type: object }\n",
    });
    const fake = fakeClient([
      read({ status: "need_files", needFiles: ["schemas/order.yaml", "../escape.yaml"] }),
      read({ status: "read", readerVersion: READER_VERSION, specs: [parsedSpec({ files: ["openapi.yaml", "schemas/order.yaml"] })], fileIssues: [] }),
    ]);

    const result = await readRepositorySpecs({ checkoutRoot: root, client: fake.client });

    expect(fake.inputs.map((input) => Object.keys(input.files).sort())).toEqual([
      ["openapi.yaml"],
      ["openapi.yaml", "schemas/order.yaml"],
    ]);
    expect(fake.inputs[1]!.unavailable).toEqual(["../escape.yaml"]);
    expect(result.report).toMatchObject({ status: "openapi", operationCount: 1, readerVersion: READER_VERSION });
    expect(result.surface?.groups[0]?.endpoints[0]?.path).toBe("/orders/{orderId}");
    expect(fake.doneCalls()).toBe(1);
  });

  test("tries a failed call once more, then falls back to the model route", async () => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\npaths: {}\n" });
    const failure: SpecReaderCallResult = { ok: false, code: "crashed", message: "The job crashed." };
    const fake = fakeClient([failure, failure]);

    const result = await readRepositorySpecs({ checkoutRoot: root, client: fake.client });

    expect(fake.inputs).toHaveLength(2);
    expect(result.surface).toBeUndefined();
    expect(result.report).toMatchObject({
      status: "reader_unavailable",
      specs: [{ path: "openapi.yaml", outcome: "unread", code: "reader_failed", message: "The spec reader did not answer." }],
    });
    expect(fake.doneCalls()).toBe(1);
  });

  test("G3 rejects the whole output when any part is invalid", async () => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\npaths: {}\n" });
    const invalid = { status: "read", readerVersion: READER_VERSION, specs: [{ ...parsedSpec(), injected: true }], fileIssues: [] };
    const fake = fakeClient([{ ok: true, output: invalid }]);

    const result = await readRepositorySpecs({ checkoutRoot: root, client: fake.client });

    expect(result.surface).toBeUndefined();
    expect(result.report).toMatchObject({ status: "spec_rejected", specs: [{ path: "openapi.yaml", code: "invalid_output" }] });
  });

  test("reports a partial spec with each skipped operation in our own words", async () => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\npaths: {}\n" });
    const fake = fakeClient([read({
      status: "read",
      readerVersion: READER_VERSION,
      specs: [parsedSpec({ skippedOperations: [{ method: "GET", path: "/bad", code: "unresolved_reference", message: "Job text." }] })],
      fileIssues: [],
    })]);

    await expect(readRepositorySpecs({ checkoutRoot: root, client: fake.client })).resolves.toMatchObject({
      report: {
        status: "openapi_partial",
        skippedOperationCount: 1,
        skippedOperations: [{
          specPath: "openapi.yaml",
          method: "GET",
          path: "/bad",
          code: "unresolved_reference",
          message: "A reference points to nothing, or to a file that could not be read.",
        }],
      },
    });
  });

  test("names the line and the reason of a root that did not parse", async () => {
    const root = await checkout({ "swagger.yaml": "swagger: '2.0'\npaths: {}\n" });
    const fake = fakeClient([read({
      status: "read",
      readerVersion: READER_VERSION,
      specs: [{ outcome: "rejected", root: "swagger.yaml", code: "parse_failed", message: "Job text." }],
      fileIssues: [{ file: "swagger.yaml", code: "parse_failed", reason: "yaml_missing_char", line: 536, column: 120 }],
    })]);

    const result = await readRepositorySpecs({ checkoutRoot: root, client: fake.client });

    const message = "A closing quote or bracket is missing. A quoted string that continues on a line with too little indentation also causes this.";
    expect(result.surface).toBeUndefined();
    expect(result.report).toEqual({
      status: "spec_rejected",
      specs: [{ path: "swagger.yaml", outcome: "rejected", code: "parse_failed", message }],
      fileIssues: [{ file: "swagger.yaml", reason: "yaml_missing_char", message, line: 536, column: 120 }],
      readerVersion: READER_VERSION,
      operationCount: 0,
      skippedOperationCount: 0,
      redactedSecretCount: 0,
    });
  });

  test("lists a referenced file that did not parse while the spec route still runs", async () => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\npaths: {}\n", "schemas/order.yaml": "x: 1\n" });
    const fake = fakeClient([read({
      status: "read",
      readerVersion: READER_VERSION,
      specs: [parsedSpec()],
      fileIssues: [{ file: "schemas/order.yaml", code: "parse_failed", reason: "yaml_duplicate_key", line: 3, column: 3 }],
    })]);

    await expect(readRepositorySpecs({ checkoutRoot: root, client: fake.client })).resolves.toMatchObject({
      surface: { groups: [{ id: "orders" }] },
      report: {
        status: "openapi",
        fileIssues: [{ file: "schemas/order.yaml", message: "A key appears twice in the same mapping.", line: 3, column: 3 }],
      },
    });
  });

  test("names a file that gate G1 refused", async () => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\n\u0000paths: {}\n" });

    await expect(readRepositorySpecs({ checkoutRoot: root, client: fakeClient([]).client })).resolves.toMatchObject({
      report: {
        status: "spec_rejected",
        specs: [{ path: "openapi.yaml", outcome: "refused", code: "nul_byte", message: "The file holds a NUL byte, so it is not a text file." }],
      },
    });
  });

  test("runs the model route when no job client exists", async () => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\npaths: {}\n" });

    await expect(readRepositorySpecs({ checkoutRoot: root })).resolves.toMatchObject({
      report: { status: "reader_unavailable", specs: [{ path: "openapi.yaml", outcome: "unread", code: "no_reader" }] },
    });
  });
});

describe("gate G3", () => {
  test("T12 rejects an output with a prototype key, an extra key or a value over its cap", () => {
    const valid = { status: "read", readerVersion: READER_VERSION, specs: [parsedSpec()], fileIssues: [] };

    expect(checkSpecReaderOutput(valid).ok).toBe(true);
    const withPrototypeKey = checkSpecReaderOutput(JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(valid).slice(1)}`));
    expect(withPrototypeKey.ok && Object.hasOwn(withPrototypeKey.output, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(checkSpecReaderOutput({ ...valid, extra: 1 }).ok).toBe(false);
    expect(checkSpecReaderOutput({
      ...valid,
      specs: [parsedSpec({ info: { title: "x".repeat(81) } })],
    }).ok).toBe(false);
  });

  test("T24 rejects a method or a path that could change a file path or a sample", () => {
    const withOperation = (method: string, path: string) => ({
      status: "read",
      readerVersion: READER_VERSION,
      specs: [parsedSpec({ operations: [{ method, path, deprecated: false, parameters: [], responses: [] }] })],
      fileIssues: [],
    });

    expect(checkSpecReaderOutput(withOperation("get", "/a")).ok).toBe(false);
    expect(checkSpecReaderOutput(withOperation("GET\nX", "/a")).ok).toBe(false);
    expect(checkSpecReaderOutput(withOperation("GET", "")).ok).toBe(false);
  });
});

describe("gate G3 on reasons and codes", () => {
  const valid = { status: "read", readerVersion: READER_VERSION, specs: [parsedSpec()], fileIssues: [] };

  test("accepts only reasons and skip codes of the fixed tables, never free text", () => {
    const issue = { file: "openapi.yaml", code: "parse_failed", reason: "yaml_bad_indent", line: 2, column: 1 };

    expect(checkSpecReaderOutput({ ...valid, fileIssues: [issue] }).ok).toBe(true);
    expect(checkSpecReaderOutput({ ...valid, fileIssues: [{ ...issue, reason: "Click https://evil.example" }] }).ok).toBe(false);
    expect(checkSpecReaderOutput({ ...valid, fileIssues: [{ ...issue, reason: "__proto__" }] }).ok).toBe(false);
    expect(checkSpecReaderOutput({ ...valid, fileIssues: [{ ...issue, line: 0 }] }).ok).toBe(false);
    expect(checkSpecReaderOutput({ ...valid, fileIssues: [{ ...issue, message: "extra" }] }).ok).toBe(false);
    expect(checkSpecReaderOutput({
      ...valid,
      specs: [{ ...parsedSpec(), skippedOperations: [{ method: "GET", path: "/a", code: "made_up", message: "x" }] }],
    }).ok).toBe(false);
  });
});

describe("report normalization", () => {
  test("keeps the issues of a stored report and drops a malformed one", async () => {
    const { normalizeProjectAnalysis } = await import("../../src/utils/analysis-normalizer");
    const report = {
      status: "spec_rejected",
      specs: [{ path: "swagger.yaml", outcome: "rejected", code: "parse_failed", message: "Bad indent.", extra: 1 }],
      fileIssues: [{ file: "swagger.yaml", reason: "yaml_bad_indent", message: "Bad indent.", line: 4, column: 2 }],
      operationCount: 0,
      skippedOperationCount: 0,
      redactedSecretCount: 0,
    };

    expect(normalizeProjectAnalysis({ referenceSourceReport: report }).referenceSourceReport).toEqual({
      ...report,
      specs: [{ path: "swagger.yaml", outcome: "rejected", code: "parse_failed", message: "Bad indent." }],
    });
    expect(normalizeProjectAnalysis({ referenceSourceReport: { ...report, status: "made_up" } }).referenceSourceReport)
      .toBeUndefined();
  });
});
