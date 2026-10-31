/**
 * PRODUCTION INCIDENT REGRESSION GUARDRAIL
 *
 * Incident 2026-10-30, flagforge generation 2745eeaf: the repository had no
 * OpenAPI or Swagger file. A file-by-file extraction step ran after the
 * analysis answer. Its route scan missed every Fastify route whose path is on
 * the next line, matched only a hidden `/openapi.json` route, and its merge
 * then dropped every endpoint of the analysis answer. The site lost its REST
 * reference: no overview, authentication or group pages, and the endpoint
 * pages were written as plain prose, without <ApiEndpoint>, request examples
 * or parameters.
 *
 * The contract, the same as before the spec route existed: without a usable
 * spec file, the REST surface is the analysis answer. The analysis prompt asks
 * for every endpoint fact, no step after the answer calls a model or changes
 * the surface on any analysis path, and every endpoint gets a page that the
 * template renders.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLANNING_FINGERPRINT_VERSION } from "@doxahq/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  analyzeProjectWithCacheState,
  documentationBriefFingerprint,
  planRevisionAwareGeneration,
  resolveDocumentationBrief,
  type AgentCacheManager,
  type AgentConfig,
  type ChatRequest,
  type DocumentationStructure,
  type ProjectAnalysis,
  type Provider,
  type RestApiReferenceSurface,
} from "../src";
import { deterministicPageRendererFor } from "../src/doxa-agent/deterministic-pages";
import { generateDocumentation } from "../src/doxa-agent/generation-service";
import { REST_ENDPOINT_TEMPLATE_RENDERER_ID } from "../src/doxa-agent/page-renderer-kind";
import { prompts } from "../src/doxa-agent/prompts";
import { ensureReferenceSections } from "../src/doxa-agent/reference-surfaces";
import { flattenStructure } from "../src/doxa-agent/structure-utils";
import { normalizeProjectAnalysis } from "../src/utils/analysis-normalizer";
import { analysisFixture } from "./fixtures";

const FULL_REST_RULE =
  "Populate REST baseUrl, servers, parameters, bodyFields, bodyContentType, responses, and authRequirement";

/** The shape of the flagforge repository that the removed route scan could not read. */
const FLAGFORGE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "flagforge", private: true }),
  "README.md": "# FlagForge\n\nFeature flags with a REST API.\n",
  // The only line that the removed scan matched: a route hidden from the docs.
  "apps/api/src/plugins/swagger.ts": [
    "export async function swaggerPlugin(fastify) {",
    '  fastify.get("/openapi.json", { schema: { hide: true } }, async () => fastify.swagger());',
    "}",
  ].join("\n"),
  // Every real route puts its path on the line after the method call.
  "apps/api/src/routes/flags.routes.ts": [
    "export default async function flagRoutes(fastify) {",
    "  const app = fastify.withTypeProvider();",
    "  app.post(",
    '    "/v1/projects/:projectId/flags",',
    "    { preHandler: fastify.requireServerKey, schema: { body: createFlagBody } },",
    "    async (request, reply) => reply.status(201).send(await createFlag(request.params.projectId, request.body)),",
    "  );",
    "  app.delete(",
    '    "/v1/projects/:projectId/flags/:flagKey",',
    "    { preHandler: fastify.requireServerKey },",
    "    async (request, reply) => reply.status(204).send(),",
    "  );",
    "}",
  ].join("\n"),
  "apps/api/src/routes/projects.routes.ts": [
    "export default async function projectRoutes(fastify) {",
    "  const app = fastify.withTypeProvider();",
    "  app.get(",
    '    "/v1/projects/:projectId",',
    "    { preHandler: fastify.requireServerKey },",
    "    async (request) => getProject(request.params.projectId),",
    "  );",
    "}",
  ].join("\n"),
};

const serverKey = {
  scheme: "bearer",
  location: "header",
  name: "Authorization",
  description: "Server API key (srv_).",
} as const;

const projectIdParameter = {
  name: "projectId",
  in: "path",
  type: "string",
  required: true,
  description: "Project ID.",
} as const;

/** The REST surface of the analysis answer, with every fact that the template renders. */
const restSurface: RestApiReferenceSurface = {
  label: "REST API",
  slug: "rest-api",
  description: "Manage projects and feature flags over HTTP.",
  baseUrl: "http://localhost:4000",
  authSchemes: [serverKey],
  sourceEvidence: [{ path: "apps/api/src/app.ts" }],
  groups: [
    {
      id: "flags",
      title: "Flags",
      description: "Create and delete the feature flags of a project.",
      sourceEvidence: [{ path: "apps/api/src/routes/flags.routes.ts" }],
      endpoints: [
        {
          id: "post-v1-projects-flags",
          title: "Create a flag",
          method: "POST",
          path: "/v1/projects/{projectId}/flags",
          description: "Create a feature flag in a project.",
          parameters: [projectIdParameter],
          bodyContentType: "application/json",
          bodyFields: [
            { name: "key", type: "string", required: true, description: "Unique flag key." },
            { name: "enabled", type: "boolean", required: false, description: "Whether the flag is on." },
          ],
          responses: [{ status: 201, contentType: "application/json", example: '{\n  "key": "new-checkout"\n}' }],
          authRequirement: serverKey,
          sourceEvidence: [{ path: "apps/api/src/routes/flags.routes.ts", kind: "source" }],
        },
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
          authRequirement: serverKey,
          sourceEvidence: [{ path: "apps/api/src/routes/flags.routes.ts", kind: "source" }],
        },
      ],
    },
    {
      id: "projects",
      title: "Projects",
      description: "Read the projects that own flags.",
      sourceEvidence: [{ path: "apps/api/src/routes/projects.routes.ts" }],
      endpoints: [{
        id: "get-v1-projects-project-id",
        title: "Get a project",
        method: "GET",
        path: "/v1/projects/{projectId}",
        description: "Get one project by its ID.",
        parameters: [projectIdParameter],
        responses: [{ status: 200, contentType: "application/json", example: '{\n  "id": "proj_123"\n}' }],
        authRequirement: serverKey,
        sourceEvidence: [{ path: "apps/api/src/routes/projects.routes.ts", kind: "source" }],
      }],
    },
  ],
};

const ENDPOINT_COUNT = 3;

const analysisAnswer: ProjectAnalysis = {
  ...analysisFixture,
  projectName: "FlagForge",
  projectCategory: "api",
  hasApiRoutes: true,
  apiEndpoints: restSurface.groups.flatMap((group) =>
    group.endpoints.map((endpoint) => ({ method: endpoint.method, path: endpoint.path, description: endpoint.title }))
  ),
  referenceSurfaces: { rest: restSurface },
};

/** What the analysis answer becomes on the model route: the answer, normalized. */
const expectedSurface = normalizeProjectAnalysis(analysisAnswer).referenceSurfaces?.rest;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function flagforgeCheckout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doxa-rest-model-route-"));
  directories.push(root);
  for (const [path, content] of Object.entries(FLAGFORGE_FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** Answers every analysis call with `analysisAnswer` and records each model call. */
function analysisProvider() {
  const chatRequests: ChatRequest[] = [];
  const provider: Provider = {
    config: { baseUrl: "https://example.invalid", apiKey: "test-key", model: "test-model" },
    async chat(request) {
      chatRequests.push(request);
      return { message: { role: "assistant", content: JSON.stringify(analysisAnswer) } };
    },
    async *chatStream() {
      yield { type: "done" as const, message: { role: "assistant" as const, content: "Exploration summary." } };
    },
  };
  return { provider, chatRequests };
}

type AnalysisPath = "full" | "incremental" | "cached";

/** No cache for a full analysis; a cached analysis with or without changed files for the others. */
function cacheFor(path: AnalysisPath): AgentCacheManager | undefined {
  if (path === "full") return undefined;
  const briefFingerprint = documentationBriefFingerprint(resolveDocumentationBrief(undefined));
  return {
    async checkAnalysis() {
      return {
        needsReanalysis: path === "incremental",
        cachedAnalysis: { ...analysisAnswer, __doxaDocumentationBriefFingerprint: briefFingerprint },
        cachedExplorationContext: "published analysis",
        currentCommitHash: "a".repeat(40),
        changedFiles: path === "incremental" ? ["apps/api/src/routes/flags.routes.ts"] : [],
        addedFiles: [],
        deletedFiles: [],
      };
    },
    async saveAnalysis() {},
    async checkDocs() {
      throw new Error("Unexpected docs cache read.");
    },
    async saveDocs() {
      throw new Error("Unexpected docs cache write.");
    },
    async updateDocPages() {
      throw new Error("Unexpected docs cache update.");
    },
  };
}

/** The model calls of each path: one analysis answer, or none for a cache hit. Nothing after it. */
const MODEL_CALLS: Record<AnalysisPath, number> = { full: 1, incremental: 1, cached: 0 };

async function analyzeFlagforge(path: AnalysisPath) {
  const { provider, chatRequests } = analysisProvider();
  const config: AgentConfig = {
    cwd: await flagforgeCheckout(),
    toolPolicy: "read_only",
    provider,
    repoMap: false,
  };
  const { analysis } = await analyzeProjectWithCacheState(config, undefined, cacheFor(path));
  return { analysis, chatRequests };
}

describe("REST reference without a spec file (model route)", () => {
  test("the analysis prompt asks for every endpoint fact", () => {
    const prompt = prompts.buildAnalysisPrompt({ explorationContext: "Fastify routes in apps/api/src/routes." });
    const text = `${prompt.system}\n${prompt.user}`;

    expect(text).toContain(FULL_REST_RULE);
    expect(text).not.toContain("Leave referenceSurfaces.rest out");
    expect(text).not.toMatch(/later step/i);
  });

  test("only spec files take the REST surface away from the analysis answer", () => {
    const prompt = prompts.buildAnalysisPrompt({
      explorationContext: "An OpenAPI file.",
      restReference: { specFiles: ["openapi.yaml"] },
    });
    const text = `${prompt.system}\n${prompt.user}`;

    expect(text).toContain("Leave referenceSurfaces.rest out");
    expect(text).not.toContain(FULL_REST_RULE);
  });

  test("a full analysis sends the full REST rules to the model", async () => {
    const { chatRequests } = await analyzeFlagforge("full");

    expect(JSON.stringify(chatRequests[0]?.messages)).toContain(FULL_REST_RULE);
  });

  test.each<AnalysisPath>(["full", "incremental", "cached"])(
    "the %s analysis keeps every endpoint of the answer with all its facts, and makes no model call after it",
    async (path) => {
      const { analysis, chatRequests } = await analyzeFlagforge(path);
      const surface = analysis.referenceSurfaces?.rest;

      expect(chatRequests).toHaveLength(MODEL_CALLS[path]);
      expect(analysis.referenceSourceReport?.status).toBe("no_spec");
      expect(surface).toEqual(expectedSurface);
      expect(surface?.groups.flatMap((group) => group.endpoints)).toHaveLength(ENDPOINT_COUNT);

      const deleteFlag = surface?.groups
        .flatMap((group) => group.endpoints)
        .find((endpoint) => endpoint.method === "DELETE");
      expect(deleteFlag?.parameters?.map((parameter) => parameter.name)).toEqual(["projectId", "flagKey"]);
      expect(deleteFlag?.authRequirement?.scheme).toBe("bearer");
    },
  );

  test("every endpoint gets a template page, next to the overview, authentication and group pages", async () => {
    const { analysis } = await analyzeFlagforge("full");
    const structure = ensureReferenceSections(guidesOnly(), analysis);
    const restPages = structure.sections.find((section) => section.id === "rest-api")?.pages ?? [];

    expect(restPages.map((page) => page.reference?.pageKind)).toEqual([
      "overview",
      "auth",
      "group",
      "endpoint",
      "endpoint",
      "group",
      "endpoint",
    ]);
    const endpointPages = restPages.filter((page) => page.reference?.pageKind === "endpoint");
    expect(endpointPages.map((page) => page.id)).toEqual([
      "post-v1-projects-flags",
      "delete-v1-projects-flags-flag-key",
      "get-v1-projects-project-id",
    ]);
    for (const page of endpointPages) {
      expect(deterministicPageRendererFor(page)?.id).toBe(REST_ENDPOINT_TEMPLATE_RENDERER_ID);
    }
  });

  test("the template writes each endpoint page with its examples and parameters, and no model call", async () => {
    const { analysis } = await analyzeFlagforge("full");
    const structure = endpointPagesOnly(ensureReferenceSections(guidesOnly(), analysis));
    const config: AgentConfig = {
      cwd: await flagforgeCheckout(),
      outputDir: "generated",
      toolPolicy: "read_only",
      provider: noModelProvider(),
      writerValidation: { maxAttempts: 1, mdxCompile: true, timeoutMs: 10_000 },
    };

    const result = await generateDocumentation(
      config,
      structure,
      undefined,
      { analysis, answers: {}, structure },
      undefined,
      undefined,
      { finalize: false },
    );

    expect(result.pages).toHaveLength(ENDPOINT_COUNT);
    const deletePage = result.pages.find((page) => page.id === "rest-api/delete-v1-projects-flags-flag-key");
    expect(deletePage?.content).toContain('apiMethod: "DELETE"');
    expect(deletePage?.content).toContain('<ApiEndpoint method="DELETE"');
    expect(deletePage?.content).toContain('<ApiRequestExample client="curl"');
    expect(deletePage?.content).toContain('<ApiParam name="flagKey" type="string" location="path" required>');
    const createPage = result.pages.find((page) => page.id === "rest-api/post-v1-projects-flags");
    expect(createPage?.content).toContain('<ApiParam name="key" type="string" location="body" required>');
    expect(createPage?.content).toContain('<ApiResponseExample status="201"');
  });

  test("a baseline planned before the fix analyzes the repository again, so its thin endpoints are not reused", () => {
    const pageInputHashes = { overview: "overview-input" };
    const plan = planRevisionAwareGeneration({
      currentPageIds: ["overview"],
      currentPageInputHashes: pageInputHashes,
      changes: [],
      planningFingerprint: `${PLANNING_FINGERPRINT_VERSION}:fast-mvp`,
      writingFingerprint: "writer",
      structuralFingerprint: "structure",
      previous: {
        planningFingerprint: "doxabot-planning-v6:fast-mvp",
        writingFingerprint: "writer",
        structuralFingerprint: "structure",
        pages: [{
          pageId: "overview",
          pageInputHash: pageInputHashes.overview,
          dependencies: {
            sourceFilesRead: ["README.md"],
            sourceFilesDiscovered: [],
            sourceEvidenceFiles: [],
            referencedSymbols: [],
            referencedRoutes: [],
          },
        }],
      },
    });

    expect(plan.analysisMode).toBe("full");
  });
});

function guidesOnly(): DocumentationStructure {
  return {
    sections: [{
      id: "guides",
      title: "Guides",
      default: true,
      pages: [{ id: "quickstart", title: "Quickstart", description: "Create a project and a first flag." }],
    }],
  };
}

/** The REST section with its endpoint pages only, so the run calls no writer model. */
function endpointPagesOnly(structure: DocumentationStructure): DocumentationStructure {
  const sections = structure.sections
    .filter((section) => section.id === "rest-api")
    .map((section) => ({
      ...section,
      pages: section.pages.filter((page) => page.reference?.pageKind === "endpoint"),
    }));
  expect(flattenStructure({ sections })).toHaveLength(ENDPOINT_COUNT);
  return { sections };
}

function noModelProvider(): Provider {
  return {
    config: { baseUrl: "https://example.invalid", apiKey: "test-key", model: "test-model" },
    async chat() {
      throw new Error("An endpoint page made a model call.");
    },
    async *chatStream() {
      throw new Error("An endpoint page made a model call.");
    },
  };
}
