import type { ParsedSpec, SpecOperation } from "@doxahq/contracts/spec-reader";

export const READER_VERSION = "a".repeat(64);

export function operation(overrides: Partial<SpecOperation> & Pick<SpecOperation, "method" | "path">): SpecOperation {
  return { deprecated: false, parameters: [], responses: [], ...overrides };
}

export function parsedSpec(overrides: Partial<ParsedSpec> = {}): ParsedSpec {
  return {
    outcome: "parsed",
    root: "openapi.yaml",
    specVersion: "3.1.0",
    files: ["openapi.yaml"],
    info: { title: "Shop API", description: "Sell things." },
    servers: [{ url: "https://api.shop.example/v1" }],
    securitySchemes: [{ name: "bearerAuth", kind: "bearer" }],
    tags: [{ name: "orders", displayName: "Orders", description: "Manage **orders**." }],
    operations: [
      operation({
        method: "GET",
        path: "/orders/{orderId}",
        tag: "orders",
        summary: "Get an order.",
        description: "Returns one order.",
        parameters: [{ name: "orderId", in: "path", type: "string", required: true }],
        responses: [{ status: 200, fields: [{ name: "id", type: "string", required: true }] }],
        security: { kind: "schemes", schemeNames: ["bearerAuth"] },
      }),
    ],
    skippedOperations: [],
    ...overrides,
  };
}
