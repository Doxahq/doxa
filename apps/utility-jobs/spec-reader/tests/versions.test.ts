import { describe, expect, test } from "vitest";
import { parsed, rejected } from "./helpers";

const petstoreOperation = {
  tags: ["pets"],
  summary: "Get a pet",
  responses: { "200": { description: "The pet" } },
};

describe("spec versions", () => {
  test("reads Swagger 2.0 through the upgrade to the 3.1 shape", () => {
    const spec = parsed({
      "swagger.json": JSON.stringify({
        swagger: "2.0",
        info: { title: "Pets", version: "1" },
        host: "api.example.com",
        basePath: "/v1",
        schemes: ["https"],
        paths: {
          "/pets/{petId}": {
            get: {
              ...petstoreOperation,
              parameters: [{ name: "petId", in: "path", required: true, type: "string" }],
              responses: { "200": { description: "The pet", schema: { $ref: "#/definitions/Pet" } } },
            },
            put: {
              tags: ["pets"],
              parameters: [
                { name: "petId", in: "path", required: true, type: "string" },
                { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } },
              ],
              responses: { "204": { description: "Saved" } },
            },
          },
        },
        definitions: { Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
      }),
    });

    expect(spec.specVersion).toBe("2.0");
    expect(spec.servers).toEqual([{ url: "https://api.example.com/v1" }]);
    expect(spec.operations.map((operation) => operation.method)).toEqual(["GET", "PUT"]);
    expect(spec.operations[0]!.responses[0]!.fields).toEqual([{ name: "name", type: "string", required: true }]);
    expect(spec.operations[1]!.requestBody).toEqual({
      contentType: "application/json",
      fields: [{ name: "name", type: "string", required: true }],
    });
  });

  test("reads OpenAPI 3.0 nullable schemas", () => {
    const spec = parsed({
      "openapi.json": JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Pets", version: "1" },
        paths: {
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "Pets",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { nickname: { type: "string", nullable: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });

    expect(spec.operations[0]!.responses[0]!.fields).toEqual([
      { name: "nickname", type: "string, nullable", required: false },
    ]);
  });

  test("reads an unquoted YAML version number", () => {
    expect(parsed({ "openapi.yaml": "openapi: 3.1\ninfo: { title: T, version: '1' }\npaths:\n  /a:\n    get: {}\n" }).specVersion)
      .toBe("3.1");
  });

  test.each([
    ["no version", "info: { title: T }\npaths: {}\n"],
    ["OpenAPI 4", "openapi: 4.0.0\npaths: {}\n"],
    ["Swagger 1.2", "swagger: '1.2'\npaths: {}\n"],
  ])("rejects a file with %s", (_label, text) => {
    expect(rejected({ "openapi.yaml": text }).code).toBe("unsupported_version");
  });

  test("rejects a spec without paths", () => {
    expect(rejected({ "openapi.yaml": "openapi: 3.1.0\ninfo: { title: T, version: '1' }\n" }).code).toBe("no_paths");
  });
});
