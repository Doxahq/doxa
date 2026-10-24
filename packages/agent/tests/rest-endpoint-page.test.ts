import {
  parseRuntimeMdx,
  RUNTIME_MDX_COMPONENT_NAMES,
  type RuntimeMdxElementNode,
  type RuntimeMdxNode,
} from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import {
  assertRestEndpointPageRenders,
  renderRestEndpointReferenceBlock,
  stripRestEndpointReferenceBlock,
} from "../src/doxa-agent/rest-endpoint-page";
import { endpointPageTitle } from "../src/doxa-agent/reference-surfaces";
import { StructurePipelineDefectError } from "../src/doxa-agent/structure-review-errors";
import type {
  RestApiReferenceEndpoint,
  RestApiReferenceSurface,
} from "../src/types";
import { buildFrontmatter, composePage } from "../src/utils/frontmatter";
import { extractMdxComponents } from "../src/utils/component-allowlist";
import { runPageValidation } from "../src/utils/page-validator";
import {
  DEFAULT_REST_API_DOCS_POLICY,
  resolveRestApiDocsPolicy,
} from "../src/doxa-agent/rest-api-policy";

const endpoint: RestApiReferenceEndpoint = {
  id: "get-user",
  title: "Get a user",
  method: "GET",
  path: "/users/{userId}",
  description: "Return one public user resource by its stable identifier.",
  parameters: [
    { name: "trace-id", in: "header", type: "string", required: false },
    { name: "include", in: "query", type: "string", required: false, enumValues: ["profile", "roles"] },
    { name: "userId", in: "path", type: "string", required: true, description: "The user identifier." },
  ],
  bodyFields: [
    { name: "audit.reason", type: "string", required: false, description: "Optional audit reason." },
  ],
  bodyContentType: "application/json",
  responses: [{
    status: 200,
    contentType: "application/json",
    description: "The matching user.",
    example: '{\n  "id": "usr_123"\n}',
    fields: [
      { name: "id", type: "string", required: true, description: "Stable user identifier." },
    ],
  }],
  authRequirement: {
    scheme: "bearer",
    location: "header",
    name: "Authorization",
    description: "Use a bearer access token.",
  },
  sourceEvidence: [{ path: "src/routes/users.ts" }],
};

const surface: RestApiReferenceSurface = {
  label: "REST API",
  slug: "rest-api",
  baseUrl: "https://api.example.com/v1",
  servers: ["https://backup.example.com/v1"],
  sourceEvidence: [],
  authSchemes: [{
    scheme: "bearer",
    location: "header",
    name: "Authorization",
    description: "Use a bearer access token.",
  }],
  groups: [],
};

function findRuntimeElement(
  nodes: readonly RuntimeMdxNode[],
  name: string,
): RuntimeMdxElementNode | undefined {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.name === name) return node;
    const nested = findRuntimeElement(node.children ?? [], name);
    if (nested) return nested;
  }
  return undefined;
}

describe("deterministic REST endpoint page blocks", () => {
  test("renders request metadata groups in a stable order", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, surface);
    const headings = [
      "Authentication",
      "Path Parameters",
      "Query Parameters",
      "Header Parameters",
      "Body",
      "Response",
    ];

    let previousIndex = -1;
    for (const heading of headings) {
      const index = block.indexOf(`title="${heading}"`);
      expect(index, heading).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(block).toContain('title="Body" detail="application/json"');
    expect(block).toContain('title="Response" detail="application/json"');
  });

  test("routes every parameter group title through the REST API policy", () => {
    const policy = resolveRestApiDocsPolicy({
      restApi: {
        paramGroupTitles: {
          auth: "Credentials",
          path: "Route values",
          query: "Search values",
          header: "Header values",
          body: "Payload",
          response: "Result",
        },
      },
    });
    const block = renderRestEndpointReferenceBlock(endpoint, surface, { policy });

    for (const title of [
      "Credentials",
      "Route values",
      "Search values",
      "Header values",
      "Payload",
      "Result",
    ]) {
      expect(block).toContain(`title="${title}"`);
    }
  });

  test("omits empty parameter groups", () => {
    const block = renderRestEndpointReferenceBlock({
      ...endpoint,
      parameters: [],
      bodyFields: [],
      responses: [],
      authRequirement: { scheme: "none" },
    }, surface);

    expect(block).not.toContain("<ApiParams");
    expect(block).not.toContain("<ApiResponseExample");
  });

  test("adds one subtle route-registry link inside the authentication group", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, surface, {
      policy: DEFAULT_REST_API_DOCS_POLICY,
      authenticationRoute: "/rest-api/authentication",
    });

    expect(block).toContain(
      "Use a bearer access token. See [Authentication](/rest-api/authentication).",
    );
    expect(block.match(/\[Authentication\]\(\/rest-api\/authentication\)/g))
      .toHaveLength(1);
    expect(() => parseRuntimeMdx(block)).not.toThrow();
  });

  test("keeps bracket-based MDX links intact through description escaping", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, surface, {
      authenticationRoute: "/rest-api/authentication",
    });

    expect(block).toContain("[Authentication](/rest-api/authentication)");
    expect(block).not.toContain("&#91;Authentication&#93;");
  });

  test("omits the shared auth link when its page is disabled", () => {
    const policy = resolveRestApiDocsPolicy({
      restApi: { authPage: { enabled: false } },
    });
    const block = renderRestEndpointReferenceBlock(endpoint, surface, {
      policy,
      authenticationRoute: "/rest-api/authentication",
    });

    expect(block).not.toContain("/rest-api/authentication");
  });

  test("omits the shared auth link when the surface has no shared schemes", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, {
      ...surface,
      authSchemes: [],
    }, {
      authenticationRoute: "/rest-api/authentication",
    });

    expect(block).not.toContain("/rest-api/authentication");
  });

  test("passes both generation and runtime MDX validation", async () => {
    const content = composePage(
      buildFrontmatter({
        title: endpoint.title,
        description: endpoint.description,
        apiMethod: endpoint.method,
        apiPath: endpoint.path,
      }, { preserveTitle: true }),
      `The endpoint returns a source-evidenced public user.\n\n${renderRestEndpointReferenceBlock(endpoint, surface)}`,
    );

    await expect(runPageValidation(content, { minBodyLength: 0 })).resolves.toMatchObject({
      ok: true,
      issues: [],
    });
    expect(() => parseRuntimeMdx(content)).not.toThrow();
  });

  test("emits only components from the canonical runtime registry", () => {
    const registered = new Set<string>(RUNTIME_MDX_COMPONENT_NAMES);
    const emitted = extractMdxComponents(
      renderRestEndpointReferenceBlock(endpoint, surface),
    );

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((name) => registered.has(name))).toBe(true);
  });

  test("uses the configured base URL in the curl sample", () => {
    expect(renderRestEndpointReferenceBlock(endpoint, surface)).toContain(
      "https://api.example.com/v1/users/{userId}",
    );
  });

  test("emits the six default request clients in policy order", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, surface);
    const clients = Array.from(
      block.matchAll(/<ApiRequestExample client="([^"]+)"/g),
      (match) => match[1],
    );

    expect(clients).toEqual([
      "curl",
      "node-fetch",
      "node-xhr",
      "python-requests",
      "python-httpx",
      "go",
    ]);
  });

  test("keeps the curl request sample byte-for-byte compatible", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, surface);
    const curl = /<ApiRequestExample client="curl"[^>]*>\n\n```bash\n([\s\S]*?)\n```\n\n<\/ApiRequestExample>/
      .exec(block)?.[1];

    expect(curl).toBe([
      "curl --request GET \\",
      "  --url 'https://api.example.com/v1/users/{userId}?include=%3Cstring%3E' \\",
      "  --header 'Authorization: Bearer <token>' \\",
      "  --header 'trace-id: <string>' \\",
      "  --header 'Content-Type: application/json' \\",
      "  --data '{\"audit\":{\"reason\":\"<string>\"}}'",
    ].join("\n"));
  });

  test("emits only request clients selected by the policy", () => {
    const policy = resolveRestApiDocsPolicy({
      restApi: { requestClients: ["curl", "go"] },
    });
    const block = renderRestEndpointReferenceBlock(endpoint, surface, { policy });

    expect(Array.from(
      block.matchAll(/<ApiRequestExample client="([^"]+)"/g),
      (match) => match[1],
    )).toEqual(["curl", "go"]);
  });

  test("keeps the curl placeholder but omits playground baseUrl in auto mode without a server", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, {
      ...surface,
      baseUrl: undefined,
      servers: [],
    });

    expect(block).toContain("https://api.example.com/users/{userId}");
    expect(block.match(/<ApiEndpoint[^>]*baseUrl=/)).toBeNull();
  });

  test("omits playground baseUrl when analysis disables browser requests", () => {
    const block = renderRestEndpointReferenceBlock(endpoint, {
      ...surface,
      playground: { enabled: false, reason: "CORS is not enabled." },
    });

    expect(block.match(/<ApiEndpoint[^>]*baseUrl=/)).toBeNull();
    expect(block).toContain("https://api.example.com/v1/users/{userId}");
  });

  test("omits playground baseUrl when policy mode is never", () => {
    const policy = resolveRestApiDocsPolicy({
      restApi: { playground: { mode: "never" } },
    });

    expect(renderRestEndpointReferenceBlock(endpoint, surface, { policy })
      .match(/<ApiEndpoint[^>]*baseUrl=/)).toBeNull();
  });

  test("uses a verified playground baseUrl in auto mode", () => {
    expect(renderRestEndpointReferenceBlock(endpoint, surface)).toContain(
      '<ApiEndpoint method="GET" path="/users/&#123;userId&#125;" baseUrl="https://api.example.com/v1">',
    );
  });

  test("renders valid output for an old cached endpoint", async () => {
    const legacyEndpoint: RestApiReferenceEndpoint = {
      id: "health",
      title: "Get health",
      method: "GET",
      path: "/health",
      description: "Return the public service health and readiness state.",
      sourceEvidence: [],
    };
    const content = composePage(
      buildFrontmatter({
        title: legacyEndpoint.title,
        description: legacyEndpoint.description,
        apiMethod: legacyEndpoint.method,
        apiPath: legacyEndpoint.path,
      }, { preserveTitle: true }),
      renderRestEndpointReferenceBlock(legacyEndpoint, surface),
    );

    await expect(runPageValidation(content, { minBodyLength: 0 })).resolves.toMatchObject({
      ok: true,
      issues: [],
    });
    expect(() => parseRuntimeMdx(content)).not.toThrow();
  });

  test("removes the deterministic block before model-driven quality repair", () => {
    const prose = "---\ntitle: Get a user\ndescription: Return one user.\n---\n\nModel-authored prose.";
    const block = renderRestEndpointReferenceBlock(endpoint, surface);
    const page = `${prose}\n\n${block}\n`;

    expect(stripRestEndpointReferenceBlock(page)).toBe(prose);
    expect(stripRestEndpointReferenceBlock(prose)).toBe(prose);
  });

  test("escapes source-backed labels, prose, and embedded code fences", async () => {
    const hostileEndpoint: RestApiReferenceEndpoint = {
      ...endpoint,
      title: 'Get a "quoted" user',
      parameters: [{
        name: "userId",
        in: "path",
        type: "string",
        required: true,
        description: "Use {current} or <external> identifiers.",
      }],
      responses: [{
        status: 200,
        contentType: "application/json",
        example: '{ "markdown": "```" }',
      }],
    };
    const content = composePage(
      buildFrontmatter({
        title: "Get a quoted user",
        description: hostileEndpoint.description,
        apiMethod: hostileEndpoint.method,
        apiPath: hostileEndpoint.path,
      }, { preserveTitle: true }),
      renderRestEndpointReferenceBlock(hostileEndpoint, surface),
    );

    await expect(runPageValidation(content, { minBodyLength: 0 })).resolves.toMatchObject({
      ok: true,
      issues: [],
    });
    const runtimeDocument = parseRuntimeMdx(content);
    expect(findRuntimeElement(runtimeDocument.nodes, "ApiEndpoint")?.props?.path)
      .toBe("/users/{userId}");
    expect(findRuntimeElement(runtimeDocument.nodes, "ApiRequestExample")?.props?.label)
      .toBe('Get a "quoted" user');
  });

  test("labels the code sample with the resolved page title, not the raw analysis title", () => {
    const legacyEndpoint: RestApiReferenceEndpoint = {
      ...endpoint,
      // What `normalizeRestEndpoint` falls back to when the analysis omits a title.
      title: "GET /users/{userId}",
    };
    const block = renderRestEndpointReferenceBlock(legacyEndpoint, surface);
    const label = /label="([^"]*)"/.exec(block)?.[1];

    expect(label).toBe(endpointPageTitle(legacyEndpoint));
    expect(label).toBe("Get a user");
    expect(label).not.toContain("/");
  });

  test("accepts a well-formed deterministic block", async () => {
    const content = composePage(
      buildFrontmatter({
        title: "Get a user",
        description: endpoint.description,
        apiMethod: endpoint.method,
        apiPath: endpoint.path,
      }, { preserveTitle: true }),
      renderRestEndpointReferenceBlock(endpoint, surface),
    );

    await expect(assertRestEndpointPageRenders(content, endpoint.id))
      .resolves.toBeUndefined();
  });

  test("rejects a malformed deterministic block as a pipeline defect", async () => {
    const content = composePage(
      buildFrontmatter({
        title: "Get a user",
        description: endpoint.description,
      }, { preserveTitle: true }),
      "<ApiEndpoint method=\"GET\" path=\"/users\">\n\n<ApiParams title=\"Path Parameters\">\n",
    );

    await expect(assertRestEndpointPageRenders(content, endpoint.id))
      .rejects.toThrowError(StructurePipelineDefectError);
    await expect(assertRestEndpointPageRenders(content, endpoint.id))
      .rejects.toThrowError(/defect in reference page generation, not in the model output/);
  });
});
