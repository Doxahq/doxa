/**
 * PRODUCTION INCIDENT REGRESSION GUARDRAIL
 *
 * Incident 2026-10-31, flagforge generation 8499e18a: the analysis answer had
 * all 23 endpoints, but the site got one, `GET /openapi.json`. A filter after
 * the answer kept a REST endpoint only when the model called the project an
 * "api" project, or when an evidence path named docs, examples, OpenAPI or
 * Swagger. Claude Sonnet 5.5 called flagforge a "platform", so the filter
 * dropped every endpoint whose evidence was a route file. The SDK reference
 * had the same filter, on "library" and "framework".
 *
 * The contract: the project category, and whether an endpoint looks internal,
 * never remove an endpoint or an export. Only the project owner's Doxabot
 * instructions do: the "API reference" page type turns the whole reference
 * off, and a "Do not document" path leaves out the endpoints and exports whose
 * evidence is only under it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DOXABOT_INSTRUCTIONS,
  DOXABOT_PAGE_TYPES,
  type DoxabotInstructions,
} from "@doxahq/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  analyzeProjectWithCacheState,
  applyReferenceInstructions,
  documentationBriefFingerprint,
  resolveDocumentationBrief,
  suggestStructure,
  type AgentCacheManager,
  type AgentConfig,
  type DocPage,
  type DocumentationGenerationBrief,
  type DocumentationStructure,
  type ProjectAnalysis,
  type Provider,
  type RestApiReferenceEndpoint,
  type RestApiReferenceGroup,
  type SdkApiReferenceModule,
} from "../src";
import { prompts } from "../src/doxa-agent/prompts";
import { analysisFixture } from "./fixtures";

type ProjectCategory = ProjectAnalysis["projectCategory"];

/** Every category: the type check fails when a new category is not listed. */
const CATEGORIES = Object.keys({
  cli: true,
  api: true,
  "web-app": true,
  library: true,
  platform: true,
  "mobile-app": true,
  "desktop-app": true,
  framework: true,
  monorepo: true,
  other: true,
} satisfies Record<ProjectCategory, true>) as ProjectCategory[];

function endpoint(method: string, path: string, title: string): RestApiReferenceEndpoint {
  return { id: `${method}-${path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, method, path, description: `${title}.`, sourceEvidence: [] };
}

function group(id: string, evidencePath: string, endpoints: RestApiReferenceEndpoint[]): RestApiReferenceGroup {
  return { id, title: id, sourceEvidence: [{ path: evidencePath, kind: "source" }], endpoints };
}

function sdkModule(id: string, evidencePath: string, exportName: string): SdkApiReferenceModule {
  return {
    id,
    title: id,
    sourceEvidence: [{ path: evidencePath, kind: "source" }],
    exports: [{ id: exportName, name: exportName, kind: "function", description: `The ${exportName} function.`, sourceEvidence: [] }],
  };
}

/**
 * The flagforge shape: route files, an admin route and a health route, all
 * with source evidence only. Not one path names docs, examples or a spec.
 */
function answerFor(projectCategory: ProjectCategory): ProjectAnalysis {
  return {
    ...analysisFixture,
    projectName: "FlagForge",
    projectCategory,
    hasApiRoutes: true,
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        sourceEvidence: [],
        groups: [
          group("flags", "apps/api/src/routes/flags.routes.ts", [
            endpoint("GET", "/v1/projects/{projectId}/flags", "List flags"),
            endpoint("POST", "/v1/projects/{projectId}/flags", "Create a flag"),
          ]),
          group("admin", "apps/api/src/admin/stats.routes.ts", [endpoint("GET", "/admin/stats", "Get usage stats")]),
          group("health", "apps/api/src/plugins/health.ts", [endpoint("GET", "/health", "Check the service")]),
        ],
      },
      sdk: {
        label: "API Reference",
        slug: "api-reference",
        sourceEvidence: [],
        modules: [
          sdkModule("client", "packages/sdk/src/index.ts", "createClient"),
          sdkModule("cache", "packages/sdk/src/internal/cache.ts", "createCache"),
        ],
      },
    },
  };
}

const ALL_ENDPOINTS = [
  "GET /v1/projects/{projectId}/flags",
  "POST /v1/projects/{projectId}/flags",
  "GET /admin/stats",
  "GET /health",
];
const ALL_EXPORTS = ["createClient", "createCache"];

function endpointsOf(analysis: ProjectAnalysis): string[] {
  return (analysis.referenceSurfaces?.rest?.groups ?? [])
    .flatMap((entry) => entry.endpoints)
    .map((entry) => `${entry.method} ${entry.path}`);
}

function exportsOf(analysis: ProjectAnalysis): string[] {
  return (analysis.referenceSurfaces?.sdk?.modules ?? [])
    .flatMap((entry) => entry.exports)
    .map((entry) => entry.name);
}

function briefWith(instructions: Partial<DoxabotInstructions>): DocumentationGenerationBrief {
  return {
    target: { kind: "public" },
    projectInstructions: {
      version: 1,
      instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, ...instructions },
      screening: { method: "heuristic", flags: [] },
      repositoryFile: { status: "disabled" },
    },
  };
}

const REFERENCE_OFF = briefWith({ pageTypes: DOXABOT_PAGE_TYPES.filter((type) => type !== "reference") });

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doxa-reference-instructions-"));
  directories.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "flagforge", private: true }));
  return root;
}

/** Answers every model call with `answer`. */
function answeringProvider(answer: unknown): Provider {
  return {
    config: { baseUrl: "https://example.invalid", apiKey: "test-key", model: "test-model" },
    async chat() {
      return { message: { role: "assistant", content: JSON.stringify(answer) } };
    },
    async *chatStream() {
      yield { type: "done" as const, message: { role: "assistant" as const, content: "Exploration summary." } };
    },
  };
}

/** A cache hit that holds `answer`, so only the steps after the answer run. */
function cacheHolding(answer: ProjectAnalysis): AgentCacheManager {
  const briefFingerprint = documentationBriefFingerprint(resolveDocumentationBrief(undefined));
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected docs cache call.");
  };
  return {
    async checkAnalysis() {
      return {
        needsReanalysis: false,
        cachedAnalysis: { ...answer, __doxaDocumentationBriefFingerprint: briefFingerprint },
        cachedExplorationContext: "published analysis",
        currentCommitHash: "a".repeat(40),
        changedFiles: [],
        addedFiles: [],
        deletedFiles: [],
      };
    },
    async saveAnalysis() {},
    checkDocs: unexpected,
    saveDocs: unexpected,
    updateDocPages: unexpected,
  };
}

async function analyze(
  answer: ProjectAnalysis,
  options: { documentationBrief?: DocumentationGenerationBrief; cache?: AgentCacheManager } = {},
): Promise<ProjectAnalysis> {
  const config: AgentConfig = {
    cwd: await checkout(),
    toolPolicy: "read_only",
    provider: answeringProvider(answer),
    repoMap: false,
    ...(options.documentationBrief ? { documentationBrief: options.documentationBrief } : {}),
  };
  const { analysis } = await analyzeProjectWithCacheState(config, undefined, options.cache);
  return analysis;
}

describe("the project category does not decide the API reference", () => {
  test.each(CATEGORIES)("a %s analysis keeps every endpoint and every export", async (category) => {
    const analysis = await analyze(answerFor(category));

    expect(endpointsOf(analysis)).toEqual(ALL_ENDPOINTS);
    expect(exportsOf(analysis)).toEqual(ALL_EXPORTS);
  });

  test("a cached platform analysis keeps every endpoint and every export", async () => {
    const answer = answerFor("platform");
    const analysis = await analyze(answer, { cache: cacheHolding(answer) });

    expect(endpointsOf(analysis)).toEqual(ALL_ENDPOINTS);
    expect(exportsOf(analysis)).toEqual(ALL_EXPORTS);
  });
});

describe("the analysis prompt asks for every served endpoint", () => {
  test("it does not ask for public endpoints only, and leaves the choice to the project instructions", () => {
    const prompt = prompts.buildAnalysisPrompt({ explorationContext: "Fastify routes in apps/api/src/routes." });
    const text = `${prompt.system}\n${prompt.user}`;

    expect(text).toContain("referenceSurfaces.rest must contain every HTTP/RPC/webhook endpoint that the project serves");
    expect(text).toContain("Leave an endpoint out only when the project instructions say so.");
    expect(text).not.toMatch(/public (served )?(HTTP\/RPC\/webhook )?endpoints only/i);
  });
});

describe("the project instructions decide the API reference", () => {
  test("with the API reference page type off, the analysis has no reference surface", async () => {
    const analysis = await analyze(answerFor("api"), { documentationBrief: REFERENCE_OFF });

    expect(analysis.referenceSurfaces).toBeUndefined();
  });

  test("a Do not document path leaves out the endpoints and exports whose evidence is under it", async () => {
    const analysis = await analyze(answerFor("platform"), {
      documentationBrief: briefWith({ doNotDocument: ["apps/api/src/admin", "packages/sdk/src/internal/**"] }),
    });

    expect(endpointsOf(analysis)).toEqual([
      "GET /v1/projects/{projectId}/flags",
      "POST /v1/projects/{projectId}/flags",
      "GET /health",
    ]);
    expect(exportsOf(analysis)).toEqual(["createClient"]);
  });

  test("an item leaves only when all of its nearest evidence is under a Do not document path", () => {
    const answer = answerFor("platform");
    const [flags] = answer.referenceSurfaces!.rest!.groups;
    const shared = { ...endpoint("GET", "/v1/shared", "Read shared data"), sourceEvidence: [
      { path: "apps/api/src/admin/shared.ts" },
      { path: "apps/api/src/routes/shared.ts" },
    ] };
    const unproven = { id: "unproven", title: "Unproven", sourceEvidence: [], endpoints: [endpoint("GET", "/v1/unproven", "Read data")] };
    const analysis = applyReferenceInstructions({
      ...answer,
      referenceSurfaces: { rest: { ...answer.referenceSurfaces!.rest!, groups: [{ ...flags!, endpoints: [shared, ...flags!.endpoints] }, unproven] } },
    }, briefWith({ doNotDocument: ["apps/api/src/admin/", "apps/api/src/routes/*.routes.ts"] }));

    // The shared endpoint has evidence outside the excluded paths, the flag
    // endpoints take the evidence of their group, and the unproven endpoint
    // has no evidence at all.
    expect(endpointsOf(analysis)).toEqual(["GET /v1/shared", "GET /v1/unproven"]);
  });
});

describe("a new plan follows the API reference choice", () => {
  /** A planner that echoes a REST endpoint page from the published structure. */
  const plannerAnswer: DocumentationStructure = {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          { id: "overview", title: "Overview", description: "Understand what FlagForge does and who it is for." },
          { id: "quickstart", title: "Quickstart", description: "Create a project and evaluate a first flag." },
        ],
      },
      {
        id: "rest-api",
        title: "REST API",
        pages: [{
          id: "get-v1-projects-project-id-flags",
          title: "List flags",
          description: "List the feature flags of a project.",
          reference: { kind: "rest", pageKind: "endpoint", endpointId: "get-v1-projects-project-id-flags" },
        }],
      },
    ],
  };

  function pagesOf(structure: DocumentationStructure): DocPage[] {
    return structure.sections.flatMap((section) => section.pages);
  }

  async function plan(documentationBrief?: DocumentationGenerationBrief): Promise<DocumentationStructure> {
    const analysis = await analyze(answerFor("platform"), { documentationBrief });
    const config: AgentConfig = {
      cwd: await checkout(),
      toolPolicy: "read_only",
      provider: answeringProvider(plannerAnswer),
      ...(documentationBrief ? { documentationBrief } : {}),
    };
    return suggestStructure(config, { analysis, answers: {}, documentationBrief });
  }

  test("by default, every endpoint and export gets a reference page", async () => {
    const pages = pagesOf(await plan());
    const endpointPages = pages.filter((page) => page.reference?.kind === "rest" && page.reference.pageKind === "endpoint");

    expect(endpointPages.map((page) => `${page.reference?.method} ${page.reference?.path}`)).toEqual(ALL_ENDPOINTS);
    expect(pages.filter((page) => page.reference?.kind === "sdk")).not.toHaveLength(0);
  });

  test("with the API reference page type off, no reference page stays, not even an echoed one", async () => {
    const structure = await plan(REFERENCE_OFF);

    expect(pagesOf(structure).filter((page) => page.reference)).toEqual([]);
    expect(structure.sections.map((section) => section.id)).toEqual(["documentation"]);
  });
});
