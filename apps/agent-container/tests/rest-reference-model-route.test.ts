/**
 * PRODUCTION INCIDENT REGRESSION GUARDRAIL
 *
 * Incident 2026-10-30, flagforge generation 2745eeaf: with no OpenAPI file in
 * the repository, the hosted analysis stage ran a file-by-file REST
 * extraction on the writer model after the analysis answer. Its route scan
 * missed the Fastify routes, and its merge dropped every endpoint, so the
 * site lost its REST reference.
 *
 * The contract for the hosted analysis stage: without a spec file, the REST
 * surface of the checkpoint is the analysis answer. The stage makes the
 * exploration call and the analysis call, and no other model call.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatRequest, ChatResponse, ChatStreamEvent, Provider } from "@doxahq/agent";
import type { ContainerGenerationStageRequest } from "@doxahq/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { runGenerationStage } from "../src/staged-generation";

const PLANNER_MODEL = "synthetic-planner";
const WRITER_MODEL = "synthetic-writer";
/** Only the analysis call asks for this; the fake provider tells the calls apart by it. */
const ANALYSIS_PROMPT_MARKER = "generate a complete project analysis JSON object";

/** Fastify routes with the path on the next line, and one hidden route on one line. */
const FLAGFORGE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "flagforge", private: true }),
  "README.md": "# FlagForge\n\nFeature flags with a REST API.\n",
  "apps/api/src/plugins/swagger.ts":
    'export async function swaggerPlugin(fastify) {\n  fastify.get("/openapi.json", { schema: { hide: true } }, async () => fastify.swagger());\n}\n',
  "apps/api/src/routes/flags.routes.ts": [
    "export default async function flagRoutes(fastify) {",
    "  const app = fastify.withTypeProvider();",
    "  app.delete(",
    '    "/v1/projects/:projectId/flags/:flagKey",',
    "    { preHandler: fastify.requireServerKey },",
    "    async (request, reply) => reply.status(204).send(),",
    "  );",
    "  app.get(",
    '    "/v1/projects/:projectId/flags",',
    "    { preHandler: fastify.requireServerKey },",
    "    async (request) => listFlags(request.params.projectId),",
    "  );",
    "}",
  ].join("\n"),
};

const projectIdParameter = { name: "projectId", in: "path", type: "string", required: true, description: "Project ID." };

const restSurface = {
  label: "REST API",
  slug: "rest-api",
  baseUrl: "http://localhost:4000",
  sourceEvidence: [],
  groups: [{
    id: "flags",
    title: "Flags",
    sourceEvidence: [{ path: "apps/api/src/routes/flags.routes.ts" }],
    endpoints: [
      {
        id: "delete-v1-projects-flags-flag-key",
        title: "Delete a flag",
        method: "DELETE",
        path: "/v1/projects/{projectId}/flags/{flagKey}",
        description: "Delete a feature flag from a project by its key.",
        parameters: [
          projectIdParameter,
          { name: "flagKey", in: "path", type: "string", required: true, description: "Flag key." },
        ],
        responses: [{ status: 204, description: "The flag was deleted." }],
        authRequirement: { scheme: "bearer", location: "header", name: "Authorization" },
        sourceEvidence: [{ path: "apps/api/src/routes/flags.routes.ts", kind: "source" }],
      },
      {
        id: "get-v1-projects-flags",
        title: "List flags",
        method: "GET",
        path: "/v1/projects/{projectId}/flags",
        description: "List the feature flags of a project.",
        parameters: [projectIdParameter],
        responses: [{ status: 200, contentType: "application/json", example: '{\n  "data": []\n}' }],
        authRequirement: { scheme: "bearer", location: "header", name: "Authorization" },
        sourceEvidence: [{ path: "apps/api/src/routes/flags.routes.ts", kind: "source" }],
      },
    ],
  }],
};

const analysisAnswer = {
  projectName: "FlagForge",
  projectType: "api",
  languages: ["TypeScript"],
  frameworks: ["Fastify"],
  entryPoints: ["apps/api/src/server.ts"],
  keyFiles: ["apps/api/src/routes/flags.routes.ts"],
  summary: "A feature flag service with a REST API.",
  projectDescription: "FlagForge serves feature flags to applications over a REST API.",
  projectCategory: "api",
  isMonorepo: true,
  hasReact: false,
  hasApiRoutes: true,
  hasCli: false,
  packages: [],
  cliCommands: [],
  configFiles: ["package.json"],
  apiEndpoints: [
    { method: "DELETE", path: "/v1/projects/{projectId}/flags/{flagKey}", description: "Delete a flag" },
    { method: "GET", path: "/v1/projects/{projectId}/flags", description: "List flags" },
  ],
  keyFeatures: ["Feature flags over HTTP"],
  installMethods: ["docker compose up"],
  externalIntegrations: [],
  referenceSurfaces: { rest: restSurface },
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("hosted analysis stage without a spec file", () => {
  test("keeps every endpoint of the analysis answer and calls no model after it", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "doxa-rest-model-route-stage-"));
    directories.push(baseDir);
    const calls: string[] = [];

    const result = await runGenerationStage(
      analysisRequest(),
      async () => {},
      new AbortController(),
      {},
      {
        workspaceBaseDir: baseDir,
        createProvider: () => recordingProvider(calls),
        createSpecReader: () => undefined,
        recordPerformance: async () => {},
        prepareWorkspace: async (_input, _emit, _abort, workspace) => {
          for (const [path, content] of Object.entries(FLAGFORGE_FILES)) {
            await mkdir(dirname(join(workspace.checkoutRoot, path)), { recursive: true });
            await writeFile(join(workspace.checkoutRoot, path), content);
          }
          return null;
        },
      },
    );

    expect(calls).toEqual(["exploration", "analysis"]);
    expect(result.stage).toBe("analysis");
    const checkpoint = "checkpoint" in result ? JSON.parse(result.checkpoint) : null;
    const surface = checkpoint?.referenceSurfaces?.rest;
    expect(checkpoint?.referenceSourceReport?.status).toBe("no_spec");
    expect(surface?.groups).toHaveLength(1);
    expect(surface?.groups[0]?.endpoints.map((endpoint: { id: string }) => endpoint.id)).toEqual([
      "delete-v1-projects-flags-flag-key",
      "get-v1-projects-flags",
    ]);
    expect(surface?.groups[0]?.endpoints[0]?.parameters.map((parameter: { name: string }) => parameter.name))
      .toEqual(["projectId", "flagKey"]);
  });
});

/**
 * Answers the analysis call with the analysis. Any other call gets an empty
 * endpoint list, as the removed extraction got for flagforge, so a step after
 * the answer that could empty the surface fails the surface checks as well.
 */
function recordingProvider(calls: string[]): Provider {
  const provider: Provider = {
    config: { baseUrl: "synthetic://local", apiKey: "synthetic", model: PLANNER_MODEL },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const isAnalysis = JSON.stringify(request.messages).includes(ANALYSIS_PROMPT_MARKER);
      calls.push(isAnalysis ? "analysis" : "other");
      const answer = isAnalysis ? analysisAnswer : { endpoints: [] };
      return {
        model: request.model,
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0 },
        message: { role: "assistant", content: JSON.stringify(answer) },
      };
    },
    chatStream: async function* (): AsyncIterable<ChatStreamEvent> {
      calls.push("exploration");
      yield {
        type: "done",
        finishReason: "stop",
        message: { role: "assistant", content: "Fastify routes in apps/api/src/routes." },
      };
    },
  };
  return provider;
}

function analysisRequest(): ContainerGenerationStageRequest {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    stage: "analysis",
    repositoryFullName: "synthetic/flagforge",
    defaultBranch: "main",
    installationAccessToken: "synthetic-installation-token",
    modelProvider: "openrouter",
    modelApiKey: "synthetic-openrouter-key",
    model: PLANNER_MODEL,
    modelConfig: { plannerModel: PLANNER_MODEL, writerModel: WRITER_MODEL },
    generationProfile: "fast-mvp",
    pageConcurrency: 2,
    siteId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333",
    projectSlug: "flagforge",
    projectName: "FlagForge",
  };
}
