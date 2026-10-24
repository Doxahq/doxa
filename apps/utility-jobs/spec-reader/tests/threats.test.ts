import { describe, expect, test } from "vitest";
import { openapi, parsed, read, rejected } from "./helpers";

/**
 * One fixture for each threat of the spec that the job stops (T2 to T27).
 * Every fixture ends in a rejection, a skipped operation or clean output;
 * none may throw.
 */

function operationWithResponseRef(ref: string): string {
  return openapi(`  /items:
    get:
      responses:
        "200":
          description: Items
          content:
            application/json:
              schema: { $ref: "${ref}" }
  /health:
    get:
      responses: { "200": { description: OK } }`);
}

function operationWithParameterRef(ref: string): string {
  return openapi(`  /items:
    get:
      parameters:
        - $ref: "${ref}"
      responses: { "200": { description: Items } }
  /health:
    get:
      responses: { "200": { description: OK } }`);
}

describe("files and references", () => {
  test.each([
    ["T2 a parent path", "../../outside.yaml#/Item"],
    ["T2 an absolute path", "/etc/passwd#/Item"],
    ["T2 a file URL", "file:///etc/passwd"],
    ["T16 a cloud metadata URL", "http://169.254.169.254/latest/meta-data"],
    ["T16 a protocol-relative URL", "//internal.example/schema.yaml"],
    ["T16 a data URL", "data:application/json,{}"],
    ["T17 an anchor name", "#ItemAnchor"],
  ])("never follows %s and never asks for it", (_label, ref) => {
    const output = read({ "openapi.yaml": operationWithParameterRef(ref) });

    expect(output.status).toBe("read");
    if (output.status !== "read" || output.specs[0]?.outcome !== "parsed") return;
    const spec = output.specs[0];
    expect(spec.operations.map((operation) => operation.path)).toEqual(["/health"]);
    expect(spec.skippedOperations).toEqual([
      expect.objectContaining({ method: "GET", path: "/items", code: "invalid_reference" }),
    ]);
  });

  test("T18 resolves a relative reference against the file, whatever $self says", () => {
    const output = read({
      "openapi.yaml": `$self: https://attacker.example/specs/openapi.yaml\n${operationWithResponseRef("./schemas/item.yaml#/Item")}`,
    });

    expect(output).toEqual({ status: "need_files", needFiles: ["schemas/item.yaml"] });
  });

  test("asks for a missing referenced file, then reads it in the next round", () => {
    const root = operationWithResponseRef("./schemas/item.yaml#/Item");

    expect(read({ "openapi.yaml": root })).toEqual({ status: "need_files", needFiles: ["schemas/item.yaml"] });
    const spec = parsed({
      "openapi.yaml": root,
      "schemas/item.yaml": "Item:\n  type: object\n  properties:\n    sku: { type: string }\n",
    });
    expect(spec.files).toEqual(["openapi.yaml", "schemas/item.yaml"]);
    expect(spec.operations[0]!.responses[0]!.fields).toEqual([{ name: "sku", type: "string", required: false }]);
  });

  test("skips an operation whose file gate G1 refused, without asking again", () => {
    const spec = parsed(
      { "openapi.yaml": operationWithParameterRef("./secrets/params.yaml#/Item") },
      { unavailable: ["secrets/params.yaml"] },
    );

    expect(spec.operations.map((operation) => operation.path)).toEqual(["/health"]);
    expect(spec.skippedOperations[0]).toMatchObject({ code: "unresolved_reference" });
  });

  test("T19 skips a reference cycle and stops a schema that contains itself", () => {
    const spec = parsed({
      "openapi.yaml": openapi(`  /loop:
    get:
      parameters: [{ $ref: "#/components/parameters/A" }]
      responses: { "200": { description: OK } }
  /orders:
    get:
      responses:
        "200":
          description: Order
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }`, `components:
  parameters:
    A: { $ref: "#/components/parameters/B" }
    B: { $ref: "#/components/parameters/A" }
  schemas:
    Order:
      type: object
      properties:
        id: { type: string }
        parent: { $ref: "#/components/schemas/Order" }`),
    });

    expect(spec.skippedOperations).toEqual([expect.objectContaining({ path: "/loop", code: "reference_cycle" })]);
    expect(spec.operations[0]!.responses[0]!.fields).toEqual([
      { name: "id", type: "string", required: false },
      { name: "parent", type: "Order", required: false },
    ]);
  });

  test("T20 stops a small spec that expands into millions of fields", () => {
    const levels = Array.from({ length: 12 }, (_, level) => {
      const properties = Array.from({ length: 10 }, (_, index) =>
        `        p${index}: { $ref: "#/components/schemas/L${level + 1}" }`
      ).join("\n");
      return `    L${level}:\n      type: object\n      properties:\n${properties}`;
    }).join("\n");
    const started = performance.now();

    const spec = parsed({
      "openapi.yaml": openapi(`  /fan-out:
    get:
      responses:
        "200":
          description: Big
          content:
            application/json:
              schema: { $ref: "#/components/schemas/L0" }`, `components:
  schemas:
${levels}
    L12: { type: string }`),
    });

    expect(spec.operations[0]!.responses[0]!.fields).toHaveLength(500);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("T21 never reads an externalValue example", () => {
    const spec = parsed({
      "openapi.yaml": openapi(`  /items:
    get:
      responses:
        "200":
          description: Items
          content:
            application/json:
              examples:
                remote: { externalValue: "http://169.254.169.254/latest/meta-data" }`),
    });

    expect(spec.operations[0]!.responses[0]).not.toHaveProperty("example");
  });
});

describe("parsing", () => {
  test("T6 rejects a YAML alias bomb", () => {
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x]"]
      .concat(Array.from({ length: 12 }, (_, index) => {
        const name = String.fromCharCode(98 + index);
        const previous = String.fromCharCode(97 + index);
        return `${name}: &${name} [${Array.from({ length: 9 }, () => `*${previous}`).join(", ")}]`;
      }))
      .join("\n");

    expect(rejected({ "openapi.yaml": `openapi: 3.1.0\npaths: {}\n${bomb}\n` }).code).toBe("parse_failed");
  });

  test.each([
    ["T7 a code tag", "x: !!js/function 'function () { return 1 }'"],
    ["T7 an include tag", "x: !include other.yaml"],
    ["T7 an object tag", "x: !!python/object:os.system ls"],
  ])("rejects %s", (_label, line) => {
    expect(rejected({ "openapi.yaml": `openapi: 3.1.0\npaths: {}\n${line}\n` })).toMatchObject({
      code: "parse_failed",
      message: "The file uses a YAML tag outside the core schema.",
    });
  });

  test("T8 reads YAML 1.2: no stays a string and 010 stays decimal", () => {
    const spec = parsed({
      "openapi.yaml": openapi(`  /flags:
    get:
      parameters:
        - { name: enabled, in: query, schema: { type: string, example: no } }
        - { name: code, in: query, schema: { type: integer, example: 010 } }
      responses: { "200": { description: OK } }`),
    });

    expect(spec.operations[0]!.parameters.map((parameter) => parameter.example)).toEqual(["no", "10"]);
  });

  test("T9 rejects duplicate YAML keys", () => {
    expect(rejected({ "openapi.yaml": "openapi: 3.1.0\nopenapi: 3.0.0\npaths: {}\n" })).toMatchObject({
      code: "parse_failed",
      message: "A key appears twice in the same mapping.",
    });
  });

  test("T10 rejects several YAML documents in one file", () => {
    expect(rejected({ "openapi.yaml": "openapi: 3.1.0\npaths: {}\n---\nopenapi: 3.0.0\npaths: {}\n" }).code)
      .toBe("parse_failed");
  });

  test.each([
    ["JSON", "openapi.json", `{"openapi":"3.1.0","paths":{},"x":${"[".repeat(10_000)}${"]".repeat(10_000)}}`],
    ["YAML", "openapi.yaml", `openapi: 3.1.0\npaths: {}\nx: ${"[".repeat(100)}${"]".repeat(100)}\n`],
  ])("T11 rejects %s nested deeper than 64 levels", (_label, path, text) => {
    expect(["too_deep", "parse_failed"]).toContain(rejected({ [path]: text }).code);
  });

  test("T12 drops prototype keys, so no object gains a prototype", () => {
    const spec = parsed({
      "openapi.json": `{"openapi":"3.1.0","__proto__":{"polluted":true},"paths":{"/a":{"get":{"responses":{"200":{"description":"OK","content":{"application/json":{"schema":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"id":{"type":"string"}}}}}}}}}}}`,
    });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(spec.operations[0]!.responses[0]!.fields).toEqual([{ name: "id", type: "string", required: false }]);
  });

  test("T13 reads properties named like object methods", () => {
    const spec = parsed({
      "openapi.yaml": openapi(`  /a:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  hasOwnProperty: { type: string }
                  toString: { type: integer }`),
    });

    expect(spec.operations[0]!.responses[0]!.fields.map((field) => field.name)).toEqual(["hasOwnProperty", "toString"]);
  });

  test("T14 keeps the exact digits of a large integer in JSON and YAML", () => {
    const json = parsed({
      "openapi.json": `{"openapi":"3.1.0","paths":{"/a":{"get":{"parameters":[{"name":"id","in":"query","schema":{"type":"integer","example":9007199254740993}}],"responses":{"200":{"description":"OK"}}}}}}`,
    });
    const yaml = parsed({
      "openapi.yaml": openapi(`  /a:
    get:
      parameters: [{ name: id, in: query, schema: { type: integer, example: 9007199254740993 } }]
      responses: { "200": { description: OK } }`),
    });

    expect(json.operations[0]!.parameters[0]!.example).toBe("9007199254740993");
    expect(yaml.operations[0]!.parameters[0]!.example).toBe("9007199254740993");
  });

  test("T15 never compiles a pattern", () => {
    const started = performance.now();
    const spec = parsed({
      "openapi.yaml": openapi(`  /a:
    get:
      parameters:
        - { name: q, in: query, schema: { type: string, pattern: "^(a+)+$", example: "${"a".repeat(40)}!" } }
      responses: { "200": { description: OK } }`),
    });

    expect(spec.operations[0]!.parameters[0]!.type).toBe("string");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("operations and IDs", () => {
  function manyOperations(count: number): string {
    const paths = Array.from({ length: count }, (_, index) => `  /items/${index}:\n    get: {}`).join("\n");
    return openapi(paths);
  }

  test("T22 rejects a spec with more than 10,000 operations", () => {
    expect(rejected({ "openapi.yaml": manyOperations(10_001) }).code).toBe("too_many_operations");
  });

  test("T22 rejects a spec with more than 1,000 tags", () => {
    const tags = Array.from({ length: 1_001 }, (_, index) => `  - name: tag-${index}`).join("\n");

    expect(rejected({ "openapi.yaml": openapi("  /a:\n    get: {}", `tags:\n${tags}`) }).code).toBe("too_many_tags");
  });

  test.each([
    ["no leading slash", "items", "invalid_path"],
    ["a space", "/items list", "invalid_path"],
    ["an unclosed parameter", "/items/{id", "invalid_path"],
    ["a nested parameter", "/items/{a{b}}", "invalid_path"],
    ["an empty parameter", "/items/{}", "invalid_path"],
  ])("T25 skips a path with %s", (_label, path, code) => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      paths: { [path]: { get: {} }, "/ok": { get: {} } },
    }) });

    expect(spec.operations.map((operation) => operation.path)).toEqual(["/ok"]);
    expect(spec.skippedOperations).toEqual([expect.objectContaining({ code })]);
  });

  test("T25 skips an additional operation whose method is not an upper-case token", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.2.0",
      paths: {
        "/cache": {
          additionalOperations: { purge: {}, "PURGE ME": {}, GET: {}, PURGE: {} },
        },
      },
    }) });

    expect(spec.operations.map((operation) => operation.method)).toEqual(["PURGE"]);
    expect(spec.skippedOperations.map((skipped) => skipped.code)).toEqual([
      "invalid_method",
      "invalid_method",
      "invalid_method",
    ]);
  });

  test.each([
    ["a newline", "X-Trace\nInjected: 1"],
    ["a space", "X Trace"],
    ["a colon", "X-Trace:"],
  ])("T26 skips an operation with a header name that holds %s", (_label, name) => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/a": { get: { parameters: [{ name, in: "header", schema: { type: "string" } }] } },
        "/b": { get: {} },
      },
    }) });

    expect(spec.operations.map((operation) => operation.path)).toEqual(["/b"]);
    expect(spec.skippedOperations[0]).toMatchObject({ code: "invalid_parameter" });
  });

  test("T27 leaves out an example larger than 16 KB", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/a": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: { "application/json": { example: { data: "x".repeat(20_000) } } },
              },
            },
          },
        },
      },
    }) });

    expect(spec.operations[0]!.responses[0]).not.toHaveProperty("example");
  });
});
