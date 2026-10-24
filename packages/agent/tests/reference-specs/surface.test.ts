import { describe, expect, test } from "vitest";
import { REDACTED, SecretRedactor } from "../../src/reference-specs/secrets";
import { buildSpecSurface } from "../../src/reference-specs/surface";
import { operation, parsedSpec, READER_VERSION } from "./fixtures";

function surfaceOf(specs = [parsedSpec()]) {
  const redactor = new SecretRedactor();
  return { surface: buildSpecSurface({ specs, readerVersion: READER_VERSION, contentHash: "c".repeat(64), redactor }), redactor };
}

describe("spec surface", () => {
  test("maps a parsed spec to the REST reference surface", () => {
    const { surface } = surfaceOf();

    expect(surface).toEqual({
      source: {
        kind: "openapi",
        specVersions: ["3.1.0"],
        files: ["openapi.yaml"],
        contentHash: "c".repeat(64),
        readerVersion: READER_VERSION,
      },
      description: "Sell things.",
      sourceEvidence: [{ path: "openapi.yaml", kind: "other" }],
      baseUrl: "https://api.shop.example/v1",
      servers: ["https://api.shop.example/v1"],
      authSchemes: [{ scheme: "bearer" }],
      groups: [{
        id: "orders",
        title: "Orders",
        description: "Manage **orders**.",
        sourceEvidence: [],
        endpoints: [{
          id: "get-orders-order-id",
          title: "Get an order",
          method: "GET",
          path: "/orders/{orderId}",
          description: "Returns one order.",
          parameters: [{ name: "orderId", in: "path", type: "string", required: true }],
          responses: [{ status: 200, fields: [{ name: "id", type: "string", required: true }] }],
          authRequirement: { scheme: "bearer" },
          sourceEvidence: [{ path: "openapi.yaml", kind: "other" }],
        }],
      }],
    });
  });

  test("T23 gives a non-Latin tag a hash ID and a second tag with the same slug a suffix", () => {
    const { surface } = surfaceOf([parsedSpec({
      tags: [{ name: "注文" }, { name: "Orders" }, { name: "orders!" }],
      operations: [
        operation({ method: "GET", path: "/a", tag: "注文" }),
        operation({ method: "GET", path: "/b", tag: "Orders" }),
        operation({ method: "GET", path: "/c", tag: "orders!" }),
      ],
    })]);

    expect(surface.groups.map((group) => group.id)).toEqual([
      expect.stringMatching(/^tag-[0-9a-f]{8}$/),
      "orders",
      "orders-2",
    ]);
  });

  test("T23 gives two paths that share a slug their own endpoint IDs", () => {
    const { surface } = surfaceOf([parsedSpec({
      operations: [
        operation({ method: "GET", path: "/users/{userId}/posts", tag: "orders" }),
        operation({ method: "GET", path: "/users/posts", tag: "orders" }),
      ],
    })]);

    expect(surface.groups[0]!.endpoints.map((endpoint) => endpoint.id)).toEqual(["get-users-posts", "get-users-posts-2"]);
  });

  test("groups an untagged operation by its first path segment", () => {
    const { surface } = surfaceOf([parsedSpec({
      tags: [],
      operations: [operation({ method: "GET", path: "/v2/invoices/{id}" })],
    })]);

    expect(surface.groups.map((group) => [group.id, group.title])).toEqual([["invoices", "Invoices"]]);
  });

  test("uses a summary as the title only when it can stay as it is", () => {
    const { surface } = surfaceOf([parsedSpec({
      operations: [
        operation({ method: "GET", path: "/a", tag: "orders", summary: "Retrieve the balance of a connected account" }),
        operation({ method: "GET", path: "/b", tag: "orders", summary: "GET /b" }),
        operation({ method: "GET", path: "/c", tag: "orders", summary: "List items (deprecated" }),
      ],
    })]);

    expect(surface.groups[0]!.endpoints.map((endpoint) => endpoint.title)).toEqual([
      "Retrieve the balance of a connected account",
      "",
      "",
    ]);
  });

  test("T35 redacts credential examples and live keys", () => {
    const { surface, redactor } = surfaceOf([parsedSpec({
      securitySchemes: [{ name: "key", kind: "apiKey", location: "header", parameterName: "X-API-Key" }],
      operations: [operation({
        method: "GET",
        path: "/a",
        tag: "orders",
        parameters: [
          { name: "Authorization", in: "header", type: "string", required: true, example: "Bearer abc" },
          { name: "X-API-Key", in: "header", type: "string", required: true, example: "key-123" },
          { name: "limit", in: "query", type: "integer", required: false, example: "20" },
        ],
        responses: [{ status: 200, fields: [], example: '{\n  "key": "sk_live_51HxAbCdEfGhIjKlMnOp"\n}' }],
      })],
    })]);

    const endpoint = surface.groups[0]!.endpoints[0]!;
    expect(endpoint.parameters!.map((parameter) => parameter.example)).toEqual([REDACTED, REDACTED, "20"]);
    expect(endpoint.responses![0]!.example).toBe(`{\n  "key": "${REDACTED}"\n}`);
    expect(redactor.count).toBe(3);
  });

  test("T43 keeps only absolute http and https servers without credentials", () => {
    const { surface } = surfaceOf([parsedSpec({
      servers: [
        { url: "/relative" },
        { url: "javascript:alert(1)" },
        { url: "https://user:secret@api.example.com" },
        { url: "https://api.example.com/v1/" },
      ],
    })]);

    expect(surface.servers).toEqual(["https://api.example.com/v1"]);
  });

  test("merges specs in order and leaves out an operation that an earlier spec has", () => {
    const { surface } = surfaceOf([
      parsedSpec(),
      parsedSpec({
        root: "billing.yaml",
        files: ["billing.yaml"],
        tags: [{ name: "invoices" }],
        operations: [
          operation({ method: "GET", path: "/orders/{orderId}", tag: "invoices" }),
          operation({ method: "GET", path: "/invoices", tag: "invoices" }),
        ],
      }),
    ]);

    expect(surface.groups.map((group) => [group.id, group.endpoints.map((endpoint) => endpoint.path)])).toEqual([
      ["orders", ["/orders/{orderId}"]],
      ["invoices", ["/invoices"]],
    ]);
    expect(surface.source!.files).toEqual(["billing.yaml", "openapi.yaml"]);
  });
});
