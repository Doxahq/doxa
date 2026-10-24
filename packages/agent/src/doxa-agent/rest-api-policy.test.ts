import { describe, expect, test } from "vitest";
import {
  DEFAULT_REST_API_DOCS_POLICY,
  isRestApiPlaygroundEnabled,
  playgroundServerUrl,
  resolveRestApiRuntimeFeatures,
  resolveRestApiDocsPolicy,
} from "./rest-api-policy";

describe("REST API documentation policy", () => {
  test("uses frozen defaults when no answers are present", () => {
    const policy = resolveRestApiDocsPolicy({});

    expect(policy).toEqual(DEFAULT_REST_API_DOCS_POLICY);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.overviewPage)).toBe(true);
    expect(Object.isFrozen(policy.authPage)).toBe(true);
    expect(Object.isFrozen(policy.groupPages)).toBe(true);
    expect(Object.isFrozen(policy.playground)).toBe(true);
    expect(Object.isFrozen(policy.paramGroupTitles)).toBe(true);
    expect(Object.isFrozen(policy.requestClients)).toBe(true);
    expect(policy.requestClients).toEqual([
      "curl",
      "node-fetch",
      "node-xhr",
      "python-requests",
      "python-httpx",
      "go",
    ]);
  });

  test("merges one override from each policy group", () => {
    const policy = resolveRestApiDocsPolicy({
      restApi: {
        overviewPage: { enabled: false, title: "HTTP API" },
        authPage: { id: "access", linkText: "Access setup" },
        groupPages: { enabled: false },
        playground: { mode: "never" },
        requestClients: ["go", "curl"],
        paramGroupTitles: { query: "Query" },
      },
    });

    expect(policy).toEqual({
      overviewPage: { enabled: false, id: "index", title: "HTTP API" },
      authPage: {
        enabled: true,
        id: "access",
        title: "Authentication",
        linkText: "Access setup",
      },
      groupPages: { enabled: false },
      playground: { mode: "never" },
      requestClients: ["go", "curl"],
      paramGroupTitles: {
        auth: "Authentication",
        path: "Path Parameters",
        query: "Query",
        header: "Header Parameters",
        body: "Body",
        response: "Response",
      },
    });
  });

  test("keeps the first occurrence of each known request client", () => {
    const policy = resolveRestApiDocsPolicy({
      restApi: {
        requestClients: ["go", "unknown", "curl", "go", 42],
      },
    });

    expect(policy.requestClients).toEqual(["go", "curl"]);
  });

  test("falls back to curl when no known request client remains", () => {
    expect(resolveRestApiDocsPolicy({
      restApi: { requestClients: ["unknown", 42] },
    }).requestClients).toEqual(["curl"]);

    expect(resolveRestApiDocsPolicy({
      restApi: { requestClients: "go" },
    }).requestClients).toEqual(["curl"]);
  });

  test("ignores invalid and empty override values", () => {
    expect(resolveRestApiDocsPolicy({
      restApi: {
        overviewPage: { enabled: "yes", id: "  ", title: null },
        playground: { mode: "sometimes" },
      },
    })).toEqual(DEFAULT_REST_API_DOCS_POLICY);
  });

  test("resolves site playground availability from policy and analyzed servers", () => {
    const surface = {
      sourceEvidence: [],
      baseUrl: "https://api.example.com",
      groups: [],
    };

    expect(isRestApiPlaygroundEnabled(surface, DEFAULT_REST_API_DOCS_POLICY)).toBe(true);
    expect(isRestApiPlaygroundEnabled(
      { ...surface, playground: { enabled: false } },
      DEFAULT_REST_API_DOCS_POLICY,
    )).toBe(false);
    expect(isRestApiPlaygroundEnabled(
      surface,
      resolveRestApiDocsPolicy({ restApi: { playground: { mode: "never" } } }),
    )).toBe(false);
    expect(isRestApiPlaygroundEnabled(
      { sourceEvidence: [], groups: [] },
      DEFAULT_REST_API_DOCS_POLICY,
    )).toBe(false);
  });

  test("disables the generated site feature when analysis rejects browser requests", () => {
    expect(resolveRestApiRuntimeFeatures({
      referenceSurfaces: {
        rest: {
          sourceEvidence: [],
          playground: { enabled: false, reason: "CORS is not enabled." },
          groups: [{
            id: "health",
            title: "Health",
            sourceEvidence: [],
            endpoints: [{
              id: "get-health",
              title: "Get health",
              method: "GET",
              path: "/health",
              description: "Read service health.",
              sourceEvidence: [],
            }],
          }],
        },
      },
    })).toEqual({ apiPlayground: false });
  });

  test.each([
    ["a local host", "http://localhost:8080"],
    ["an https localhost", "https://localhost"],
    ["a private IP address", "https://10.0.0.1"],
    ["a metadata IP address", "https://169.254.169.254"],
    ["an IPv6 address", "https://[::1]/v1"],
    ["a user name and password", "https://user:pass@api.example.com"],
    ["an internal name", "https://api.internal"],
    ["a single-label host", "https://intranet/api"],
    ["a mDNS name", "https://printer.local"],
    ["plain http", "http://api.example.com"],
    ["a relative URL", "/v1"],
  ])("T43 keeps the playground off for %s", (_label, url) => {
    const surface = { label: "REST API", sourceEvidence: [], groups: [], baseUrl: url };

    expect(playgroundServerUrl(surface)).toBeUndefined();
    expect(isRestApiPlaygroundEnabled(surface, DEFAULT_REST_API_DOCS_POLICY)).toBe(false);
  });

  test("T43 calls the first public https server", () => {
    const surface = {
      label: "REST API",
      sourceEvidence: [],
      groups: [],
      baseUrl: "http://localhost:3000",
      servers: ["https://10.0.0.1", "https://api.shop.example.com/v1"],
    };

    expect(playgroundServerUrl(surface)).toBe("https://api.shop.example.com/v1");
    expect(isRestApiPlaygroundEnabled(surface, DEFAULT_REST_API_DOCS_POLICY)).toBe(true);
  });
});
