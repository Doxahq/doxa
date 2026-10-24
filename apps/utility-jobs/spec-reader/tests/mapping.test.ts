import { describe, expect, test } from "vitest";
import { readSpecs } from "../src/read-specs";
import { openapi, parsed, TEST_READER_VERSION } from "./helpers";

const ORDER_SPEC = openapi(`  /orders/{orderId}:
    get:
      tags: [orders]
      responses:
        "200":
          description: The order
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }`, `components:
  schemas:
    Order:
      type: object
      required: [id]
      properties:
        id: { type: string }
        customer: { $ref: "#/components/schemas/Customer" }
        items:
          type: array
          items: { $ref: "#/components/schemas/Item" }
        payment:
          oneOf: [{ $ref: "#/components/schemas/Card" }, { $ref: "#/components/schemas/BankAccount" }]
        parent: { $ref: "#/components/schemas/Order" }
    Customer:
      type: object
      properties:
        name: { type: string }
        address: { $ref: "#/components/schemas/Address" }
    Address:
      type: object
      properties:
        city: { type: string }
    Item:
      type: object
      properties:
        sku: { type: string }
        qty: { type: integer, format: int32 }
    Card: { type: object, properties: { last4: { type: string } } }
    BankAccount: { type: object, properties: { iban: { type: string } } }`);

describe("schema to fields", () => {
  test("flattens the Order example of the spec", () => {
    const fields = parsed({ "openapi.yaml": ORDER_SPEC }).operations[0]!.responses[0]!.fields;

    expect(fields.map((field) => [field.name, field.type, field.required])).toEqual([
      ["id", "string", true],
      ["customer.name", "string", false],
      ["customer.address.city", "string", false],
      ["items[].sku", "string", false],
      ["items[].qty", "integer (int32)", false],
      ["payment", "one of: Card, BankAccount", false],
      ["parent", "Order", false],
    ]);
  });

  test("merges allOf parts in order; a later part wins a property name", () => {
    const spec = parsed({ "openapi.yaml": openapi(`  /pets:
    post:
      requestBody:
        content:
          application/json:
            schema:
              allOf:
                - { $ref: "#/components/schemas/Base" }
                - type: object
                  required: [name]
                  properties:
                    id: { type: integer, description: The override. }
                    name: { type: string }`, `components:
  schemas:
    Base:
      type: object
      required: [id]
      properties:
        id: { type: string }
        createdAt: { type: string, format: date-time }`) });

    expect(spec.operations[0]!.requestBody!.fields).toEqual([
      { name: "id", type: "integer", required: true, description: "The override." },
      { name: "createdAt", type: "string (date-time)", required: false },
      { name: "name", type: "string", required: true },
    ]);
  });

  test("stops at six object levels and shows the deeper schema by its name", () => {
    const levels = Array.from({ length: 8 }, (_, level) =>
      `    L${level}:\n      type: object\n      properties:\n        next: { $ref: "#/components/schemas/L${level + 1}" }`
    ).join("\n");
    const spec = parsed({ "openapi.yaml": openapi(`  /deep:
    get:
      responses:
        "200":
          description: Deep
          content:
            application/json:
              schema: { $ref: "#/components/schemas/L0" }`, `components:\n  schemas:\n${levels}\n    L8: { type: string }`) });

    expect(spec.operations[0]!.responses[0]!.fields).toEqual([
      { name: "next.next.next.next.next.next", type: "L6", required: false },
    ]);
  });

  test("describes a root array of objects with [] names", () => {
    const spec = parsed({ "openapi.yaml": openapi(`  /items:
    get:
      responses:
        "200":
          description: Items
          content:
            application/json:
              schema: { type: array, items: { type: object, properties: { id: { type: string } } } }`) });

    expect(spec.operations[0]!.responses[0]!.fields).toEqual([{ name: "[].id", type: "string", required: false }]);
  });
});

describe("operations", () => {
  test("keeps spec order, drops x-internal and x-hidden, and reads the 3.2 methods", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.2.0",
      paths: {
        "/orders": { get: {}, post: { "x-internal": true } },
        "/admin": { "x-hidden": true, get: {} },
        "/orders/search": { query: {} },
        "/cache": { additionalOperations: { PURGE: {} } },
      },
    }) });

    expect(spec.operations.map((operation) => `${operation.method} ${operation.path}`)).toEqual([
      "GET /orders",
      "QUERY /orders/search",
      "PURGE /cache",
    ]);
  });

  test("lets operation parameters replace path parameters and adds undeclared path parameters", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/projects/{projectId}/flags/{flagKey}": {
          parameters: [
            { name: "projectId", in: "path", description: "Path level.", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          ],
          get: {
            parameters: [{ name: "projectId", in: "path", description: "Operation level.", schema: { type: "string" } }],
          },
        },
      },
    }) });

    expect(spec.operations[0]!.parameters).toEqual([
      { name: "projectId", in: "path", type: "string", required: true, description: "Operation level." },
      { name: "limit", in: "query", type: "integer", required: false, example: "20" },
      { name: "flagKey", in: "path", type: "string", required: true },
    ]);
  });

  test("turns a 3.2 querystring parameter into one query parameter for each field", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.2.0",
      paths: {
        "/search": {
          get: {
            parameters: [{
              name: "filter",
              in: "querystring",
              content: {
                "application/x-www-form-urlencoded": {
                  schema: { type: "object", required: ["q"], properties: { q: { type: "string" }, page: { type: "integer" } } },
                },
              },
            }],
          },
        },
      },
    }) });

    expect(spec.operations[0]!.parameters).toEqual([
      { name: "q", in: "query", type: "string", required: true },
      { name: "page", in: "query", type: "integer", required: false },
    ]);
  });

  test("labels range and default responses and marks a 3.2 item stream", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.2.0",
      paths: {
        "/events": {
          get: {
            responses: {
              "2XX": {
                description: "Events",
                content: {
                  "text/event-stream": {
                    itemSchema: { type: "object", properties: { event: { type: "string" } } },
                  },
                },
              },
              default: { description: "Error" },
              teapot: { description: "Not a status" },
            },
          },
        },
      },
    }) });

    expect(spec.operations[0]!.responses).toEqual([
      {
        status: 200,
        statusLabel: "2XX",
        description: "Events",
        contentType: "text/event-stream",
        fields: [{ name: "event", type: "string", required: false }],
        stream: true,
      },
      { status: 0, statusLabel: "default", description: "Error", fields: [] },
    ]);
  });

  test("prints a JSON body example with exact numbers and keeps a text example as it is", () => {
    const spec = parsed({ "openapi.json": `{"openapi":"3.1.0","paths":{"/a":{"post":{"requestBody":{"content":{"application/json":{"example":{"id":9007199254740993,"tags":["a"]}}}},"responses":{"200":{"description":"OK","content":{"text/plain":{"example":"pong"}}}}}}}}` });

    expect(spec.operations[0]!.requestBody!.example).toBe('{\n  "id": 9007199254740993,\n  "tags": [\n    "a"\n  ]\n}');
    expect(spec.operations[0]!.responses[0]!.example).toBe("pong");
  });
});

describe("tags, security and servers", () => {
  test("orders tags by the root list, then first use, with 3.2 children after their parent", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.2.0",
      tags: [
        { name: "billing-invoices", parent: "billing", summary: "Invoices" },
        { name: "orders", "x-displayName": "Orders", description: "Manage orders." },
        { name: "billing" },
      ],
      paths: {
        "/a": { get: { tags: ["users"] } },
        "/b": { get: { tags: ["orders"] } },
        "/c": { get: {} },
      },
    }) });

    expect(spec.tags).toEqual([
      { name: "orders", displayName: "Orders", description: "Manage orders." },
      { name: "billing" },
      { name: "billing-invoices", displayName: "Invoices" },
      { name: "users" },
    ]);
    expect(spec.operations.map((operation) => operation.tag)).toEqual(["users", "orders", undefined]);
  });

  test("maps security schemes and the first security requirement", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
          badKey: { type: "apiKey", in: "header", name: "X Bad" },
          mtls: { type: "mutualTLS" },
        },
      },
      paths: {
        "/inherited": { get: {} },
        "/public": { get: { security: [] } },
        "/keyed": { get: { security: [{ apiKey: [] }, { bearerAuth: [] }] } },
        "/optional": { get: { security: [{}] } },
      },
    }) });

    expect(spec.securitySchemes).toEqual([
      { name: "bearerAuth", kind: "bearer" },
      { name: "apiKey", kind: "apiKey", location: "header", parameterName: "X-API-Key" },
    ]);
    expect(spec.operations.map((operation) => operation.security)).toEqual([
      { kind: "schemes", schemeNames: ["bearerAuth"] },
      { kind: "none" },
      { kind: "schemes", schemeNames: ["apiKey"] },
      { kind: "none" },
    ]);
  });

  test("replaces server variables by their defaults", () => {
    const spec = parsed({ "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      servers: [
        { url: "https://{region}.api.example.com/{version}", variables: { region: { default: "eu" }, version: { default: "v2" } } },
        { url: "https://api.example.com\n/injected" },
      ],
      paths: { "/a": { get: {} } },
    }) });

    expect(spec.servers).toEqual([{ url: "https://eu.api.example.com/v2" }]);
  });
});

describe("whole calls", () => {
  test("gives byte-identical output for the same input", () => {
    const input = { roots: ["openapi.yaml"], files: { "openapi.yaml": ORDER_SPEC } };

    expect(JSON.stringify(readSpecs(input, TEST_READER_VERSION))).toBe(JSON.stringify(readSpecs(input, TEST_READER_VERSION)));
  });

  test("leaves out a root that another spec references as a part", () => {
    const output = readSpecs({
      roots: ["api/openapi.yaml", "api/paths.yaml"],
      files: {
        "api/openapi.yaml": openapi(`  /a:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "./paths.yaml#/components/schemas/A" }`),
        "api/paths.yaml": "openapi: 3.1.0\npaths: {}\ncomponents:\n  schemas:\n    A: { type: object, properties: { a: { type: string } } }\n",
      },
    }, TEST_READER_VERSION);

    expect(output.status === "read" ? output.specs.map((spec) => spec.root) : output).toEqual(["api/openapi.yaml"]);
  });
});
