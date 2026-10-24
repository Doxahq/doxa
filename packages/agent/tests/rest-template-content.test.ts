import { describe, expect, test } from "vitest";
import { buildSpecSurface } from "../src/reference-specs/surface";
import { SecretRedactor } from "../src/reference-specs/secrets";
import { ensureReferenceSections } from "../src/doxa-agent/reference-surfaces";
import { renderRestEndpointReferenceBlock } from "../src/doxa-agent/rest-endpoint-page";
import { exampleFromFields } from "../src/doxa-agent/rest-json-example";
import { buildRestRequestModel } from "../src/doxa-agent/rest-request-samples";
import type { RestApiReferenceEndpoint, RestApiReferenceField, RestApiReferenceSurface } from "../src/types";
import { analysisFixture } from "./fixtures";
import { parsedSpec, READER_VERSION } from "./reference-specs/fixtures";

const field = (name: string, type = "string", example?: string): RestApiReferenceField => ({
  name,
  type,
  required: true,
  ...(example === undefined ? {} : { example }),
});

const surface: RestApiReferenceSurface = {
  label: "REST API",
  slug: "rest-api",
  baseUrl: "https://api.example.com",
  sourceEvidence: [],
  groups: [],
};

const endpoint = (overrides: Partial<RestApiReferenceEndpoint> = {}): RestApiReferenceEndpoint => ({
  id: "list-environments",
  title: "List environments",
  method: "GET",
  path: "/v1/projects/{projectId}/environments",
  description: "",
  sourceEvidence: [],
  ...overrides,
});

describe("example bodies from fields", () => {
  test("nests dotted paths and array items like the real body", () => {
    expect(exampleFromFields([
      field("data[].id"),
      field("data[].key", "string", "production"),
      field("data[].owner.email", "string", "ada@example.com"),
      field("meta.total", "integer", "2"),
      field("meta.hasMore", "boolean", "false"),
      field("meta.cursor", "string", "null"),
    ])).toEqual({
      data: [{ id: "<string>", key: "production", owner: { email: "ada@example.com" } }],
      meta: { total: 2, hasMore: false, cursor: null },
    });
  });

  test("lets child fields take the place of their parent field, in either order", () => {
    expect(exampleFromFields([field("user", "object"), field("user.id")])).toEqual({ user: { id: "<string>" } });
    expect(exampleFromFields([field("user.id"), field("user", "object")])).toEqual({ user: { id: "<string>" } });
  });

  test("returns an array for a body whose root is an array", () => {
    expect(exampleFromFields([field("[].id"), field("[].name")])).toEqual([{ id: "<string>", name: "<string>" }]);
  });

  test("keeps a number that a JavaScript number would round as text", () => {
    expect(exampleFromFields([field("id", "integer", "9007199254740993")])).toEqual({ id: "9007199254740993" });
  });

  test("renders a nested response example on the page", () => {
    const block = renderRestEndpointReferenceBlock(endpoint({
      responses: [{ status: 200, fields: [field("data[].id"), field("data[].key", "string", "production")] }],
    }), surface);

    expect(block).toContain('"data": [\n    {\n      "id": "<string>",\n      "key": "production"\n    }\n  ]');
    expect(block).not.toContain('"data[].id":');
  });
});

describe("credentials in request samples", () => {
  test.each([
    ["a bearer token with no location", { scheme: "bearer" as const }, "Authorization: Bearer <token>"],
    ["an OAuth 2 token", { scheme: "oauth2" as const }, "Authorization: Bearer <access-token>"],
    ["an API key header", { scheme: "apiKey" as const, location: "header" as const, name: "X-FlagForge-Key" }, "X-FlagForge-Key: <api-key>"],
    ["an API key cookie", { scheme: "apiKey" as const, location: "cookie" as const, name: "session" }, "Cookie: session=<api-key>"],
  ])("sends %s", (_label, authRequirement, header) => {
    const model = buildRestRequestModel(endpoint({ authRequirement }), "https://api.example.com");

    expect(model.headers.map(({ name, value }) => `${name}: ${value}`)).toContain(header);
  });

  test("sends an API key query parameter in the URL", () => {
    const model = buildRestRequestModel(
      endpoint({ authRequirement: { scheme: "apiKey", location: "query", name: "api_key" } }),
      "https://api.example.com",
    );

    expect(model.url).toBe("https://api.example.com/v1/projects/{projectId}/environments?api_key=%3Capi-key%3E");
    expect(model.headers).toEqual([]);
  });

  test("sends nothing for a public endpoint", () => {
    expect(buildRestRequestModel(endpoint({ authRequirement: { scheme: "none" } }), "https://api.example.com").headers).toEqual([]);
  });
});

describe("text where the spec has none", () => {
  test("writes no filler sentence for a field or a parameter without a description", () => {
    const block = renderRestEndpointReferenceBlock(endpoint({
      parameters: [{ name: "projectId", in: "path", type: "string", required: true }],
      responses: [{ status: 200, fields: [field("id"), field("key", "string", "production")] }],
    }), surface);

    expect(block).toContain('<ApiParam name="projectId" type="string" location="path" required />');
    expect(block).toContain('<ApiParam name="id" type="string" location="response" required />');
    expect(block).toContain("Example: production.");
    expect(block).not.toMatch(/A string (?:field|value)/);
  });

  test("does not repeat the summary as the description, and names no path in the page description", () => {
    const spec = parsedSpec();
    const operation = { ...spec.operations[0]!, summary: "List environments" };
    delete operation.description;
    const specSurface = buildSpecSurface({
      specs: [{ ...spec, operations: [operation] }],
      readerVersion: READER_VERSION,
      contentHash: "hash",
      redactor: new SecretRedactor(),
    });
    const restEndpoint = specSurface.groups[0]!.endpoints[0]!;

    expect(restEndpoint.description).toBe("");
    const structure = ensureReferenceSections({ sections: [] }, { ...analysisFixture, referenceSurfaces: { rest: specSurface } });
    const page = structure.sections.flatMap((section) => section.pages).find((candidate) => candidate.reference?.pageKind === "endpoint");
    expect(page?.description).toBe("List environments: the parameters, responses and errors of this endpoint.");
  });
});
