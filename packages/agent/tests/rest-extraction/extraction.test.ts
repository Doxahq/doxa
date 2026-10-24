import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatRequest, ChatResponse, Provider } from "../../src/core";
import { extractRestReference, REST_EXTRACTION_PROMPT_VERSION } from "../../src/rest-extraction";
import { endpointFromAnswer, mergeExtractedEndpoints } from "../../src/rest-extraction/merge";
import { SecretRedactor } from "../../src/reference-specs/secrets";
import type { AgentConfig, ProjectAnalysis, RestApiReferenceEndpoint } from "../../src/types";
import { analysisFixture } from "../fixtures";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doxa-rest-extraction-"));
  directories.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

type Answer = (request: ChatRequest) => { content: string; finishReason?: string };

function fakeProvider(answer: Answer): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    config: { baseUrl: "https://example.test", apiKey: "test", model: "writer-model" },
    requests,
    async chat(request): Promise<ChatResponse> {
      requests.push(request);
      const { content, finishReason = "stop" } = answer(request);
      return { message: { role: "assistant", content }, finishReason };
    },
    async *chatStream() {
      throw new Error("Streaming is not used by this test.");
    },
  };
}

function endpointsAnswer(endpoints: Array<{ file: string; method: string; path: string; line?: number; title?: string }>): string {
  return JSON.stringify({
    endpoints: endpoints.map((endpoint) => ({
      title: "",
      description: "",
      parameters: [],
      bodyFields: [],
      responses: [],
      auth: "unknown",
      ...endpoint,
    })),
  });
}

/** The files of one request, from its numbered source blocks. */
function requestedFiles(request: ChatRequest): string[] {
  const user = request.messages.find((message) => message.role === "user")?.content ?? "";
  return [...user.matchAll(/<file path="([^"]+)"/g)].map((match) => match[1]!);
}

function config(root: string, provider: Provider): AgentConfig {
  return { cwd: root, outputDir: "generated", toolPolicy: "read_only", provider, restExtractionModel: "writer-model", concurrency: 2 };
}

function analysisWith(endpoints: Array<Pick<RestApiReferenceEndpoint, "id" | "method" | "path"> & { file: string }>): ProjectAnalysis {
  return {
    ...analysisFixture,
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        sourceEvidence: [],
        groups: [{
          id: "users",
          title: "Users",
          sourceEvidence: [{ path: "src/users.ts" }],
          endpoints: endpoints.map(({ file, ...endpoint }) => ({
            ...endpoint,
            title: "From analysis",
            description: "",
            sourceEvidence: [{ path: file }],
          })),
        }],
      },
    },
  };
}

describe("model route extraction", () => {
  test("extracts endpoints file by file and groups them by the analysis groups and path segments", async () => {
    const root = await checkout({
      "src/users.ts": 'router.get("/users", list);\nrouter.post("/users", create);',
      "src/billing.ts": 'router.get("/invoices", list);',
    });
    const provider = fakeProvider((request) => ({
      content: endpointsAnswer(requestedFiles(request).flatMap((file) => file === "src/users.ts"
        ? [
            { file, method: "post", path: "/users", line: 2, title: "Create a user" },
            { file, method: "GET", path: "/users", line: 1, title: "List users" },
          ]
        : [{ file, method: "GET", path: "/invoices", line: 1, title: "List invoices" }])),
    }));

    const result = await extractRestReference(config(root, provider), analysisWith([]));
    const rest = result.referenceSurfaces?.rest;

    expect(rest?.groups.map((group) => [group.id, group.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)])).toEqual([
      ["users", ["GET /users", "POST /users"]],
      ["invoices", ["GET /invoices"]],
    ]);
    expect(rest?.extraction).toEqual({
      promptVersion: REST_EXTRACTION_PROMPT_VERSION,
      model: "writer-model",
      files: ["src/billing.ts", "src/users.ts"],
    });
    expect(result.apiEndpoints).toHaveLength(3);
  });

  test("splits a unit whose answer stops at the output limit", async () => {
    const root = await checkout({
      "src/a.ts": 'router.get("/a", a);',
      "src/b.ts": 'router.get("/b", b);',
    });
    const provider = fakeProvider((request) => {
      const files = requestedFiles(request);
      if (files.length > 1) return { content: '{"endpoints": [', finishReason: "length" };
      return { content: endpointsAnswer([{ file: files[0]!, method: "GET", path: `/${files[0]!.slice(4, 5)}` }]) };
    });

    const result = await extractRestReference(config(root, provider), analysisWith([]));

    expect(provider.requests.map(requestedFiles)).toEqual([["src/a.ts", "src/b.ts"], ["src/a.ts"], ["src/b.ts"]]);
    expect(result.referenceSurfaces?.rest?.groups.flatMap((group) => group.endpoints.map((endpoint) => endpoint.path)))
      .toEqual(["/a", "/b"]);
  });

  test("reuses the endpoints of unchanged files with no model call", async () => {
    const root = await checkout({
      "src/users.ts": 'router.get("/users", list);',
      "src/teams.ts": 'router.get("/teams", list);',
    });
    const previous = mergeExtractedEndpoints(analysisWith([]), [
      { file: "src/users.ts", line: 1, endpoint: { title: "List users", method: "GET", path: "/users", description: "", sourceEvidence: [{ path: "src/users.ts" }] } },
    ], { promptVersion: REST_EXTRACTION_PROMPT_VERSION, model: "writer-model", files: ["src/teams.ts", "src/users.ts"] });
    const provider = fakeProvider(() => ({
      content: endpointsAnswer([{ file: "src/teams.ts", method: "GET", path: "/teams" }]),
    }));

    const result = await extractRestReference(config(root, provider), analysisWith([]), {
      previous,
      changedPaths: new Set(["src/teams.ts"]),
    });

    expect(provider.requests.map(requestedFiles)).toEqual([["src/teams.ts"]]);
    expect(result.referenceSurfaces?.rest?.groups.map((group) => [group.id, group.endpoints.map((endpoint) => endpoint.path)]))
      .toEqual([["users", ["/users"]], ["teams", ["/teams"]]]);
  });

  test("keeps the analysis endpoints of a file whose extraction failed", async () => {
    const root = await checkout({ "src/users.ts": 'router.get("/users", list);' });
    const provider = fakeProvider(() => ({ content: "not json" }));

    const result = await extractRestReference(
      config(root, provider),
      analysisWith([{ id: "list-users", method: "GET", path: "/users", file: "src/users.ts" }]),
    );

    expect(result.referenceSurfaces?.rest?.groups[0]?.endpoints[0]?.title).toBe("From analysis");
    expect(result.referenceSurfaces?.rest?.extraction).toBeUndefined();
  });

  test("starts no call after the time budget and keeps the analysis endpoints", async () => {
    const root = await checkout({ "src/users.ts": 'router.get("/users", list);' });
    const analysis = analysisWith([{ id: "list-users", method: "GET", path: "/users", file: "src/users.ts" }]);
    const provider = fakeProvider(() => ({ content: "{}" }));

    await expect(extractRestReference(config(root, provider), analysis, { timeBudgetMs: 0 })).resolves.toBe(analysis);
    expect(provider.requests).toHaveLength(0);
  });

  test("leaves the analysis as it is when extraction is off", async () => {
    const root = await checkout({ "src/users.ts": 'router.get("/users", list);' });
    const analysis = analysisWith([]);
    const provider = fakeProvider(() => ({ content: "{}" }));

    await expect(extractRestReference({ ...config(root, provider), restExtractionModel: undefined }, analysis))
      .resolves.toBe(analysis);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("extracted endpoint checks", () => {
  const answer = {
    file: "src/users.ts",
    method: "get",
    path: "/users/{id}",
    title: "Get a user",
    description: "Returns <script>alert(1)</script> one user.",
    parameters: [
      { name: "id", in: "path" as const, type: "string", required: false },
      { name: "X Bad\nHeader", in: "header" as const, type: "string", required: false },
    ],
    bodyFields: [],
    responses: [{ status: 200, fields: [{ name: "token", type: "string", required: true, description: "Like sk_live_51HxAbCdEfGhIjKlMnOp." }] }],
    auth: "bearer" as const,
  };

  test("sanitizes text, drops unusable header names and makes path parameters required", () => {
    const result = endpointFromAnswer(answer, new SecretRedactor());

    expect(result?.endpoint.method).toBe("GET");
    expect(result?.endpoint.description).not.toContain("<script>");
    expect(result?.endpoint.parameters).toEqual([{ name: "id", in: "path", type: "string", required: true }]);
    expect(result?.endpoint.responses?.[0]?.fields?.[0]?.description).not.toContain("sk_live_");
    expect(result?.endpoint.authRequirement).toEqual({ scheme: "bearer" });
  });

  test.each(["users", "/users list", "/users\n/x"])("drops an endpoint with the path %j", (path) => {
    expect(endpointFromAnswer({ ...answer, path }, new SecretRedactor())).toBeUndefined();
  });
});
