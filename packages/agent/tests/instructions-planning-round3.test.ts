import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DOXABOT_INSTRUCTIONS,
  type DoxabotInstructions,
  type DoxabotPageType,
} from "@doxahq/contracts";
import { afterEach, describe, expect, test } from "vitest";

import type {
  ChatRequest,
  ChatResponse,
  DocPage,
  DocumentationStructure,
  GeneratedPageContent,
  PlanRemoval,
  ProjectAnalysis,
  Provider,
} from "../src";
import { resolveDocumentationBrief } from "../src";
import { buildPageEvidenceBundle } from "../src/doxa-agent/evidence-bundle";
import { orderAndPersistNav, readNavOrderManifest } from "../src/doxa-agent/nav-order";
import { buildStructureReviewPrompt } from "../src/doxa-agent/prompts/dynamic/builders";
import {
  applyProjectInstructions,
  filterPlanByInstructions,
  pagesMissingPageType,
} from "../src/doxa-agent/project-instructions";
import { StructurePipelineDefectError } from "../src/doxa-agent/structure-review-errors";
import { areErrorsCausedByRemovals } from "../src/doxa-agent/structure-runner";
import { generateStructureWithRetry, StructureGenerationFailedError } from "../src/doxa-agent/structure-runner";
import { normalizeProjectAnalysis } from "../src/utils/analysis-normalizer";
import { collectionsWithPages } from "../src/utils/documentation-collection-policy";
import { applyCollectionsToStructure } from "../src/utils/documentation-collections";
import {
  headingNamesTurnedOffType,
  turnedOffTypeNamedBy,
  turnedOffTypeOfPage,
} from "../src/utils/planned-page-types";
import { analysisFixture } from "./fixtures";

function briefWith(overrides: Partial<DoxabotInstructions> = {}) {
  return resolveDocumentationBrief({
    target: { kind: "public" },
    projectInstructions: {
      version: 3,
      instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, ...overrides },
      screening: { method: "heuristic", flags: [] },
      repositoryFile: { status: "disabled" },
    },
  });
}

const NO_TROUBLESHOOTING = { pageTypes: ["quickstart", "guides", "reference", "concepts"] } satisfies Partial<DoxabotInstructions>;
const NO_GUIDES = { pageTypes: ["quickstart", "reference", "concepts", "troubleshooting"] } satisfies Partial<DoxabotInstructions>;

function page(id: string, title: string, extra: Partial<DocPage> = {}): DocPage {
  return { id, title, description: `What a reader learns on the ${title} page, with its evidence.`, ...extra };
}

function plan(...pages: DocPage[]): DocumentationStructure {
  return { sections: [{ id: "documentation", title: "Documentation", default: true, pages }] };
}

const titlesOf = (structure: DocumentationStructure) =>
  structure.sections.flatMap((section) => section.pages).map((item) => item.title);

/** A provider that answers each call with the next answer (the last one repeats), and records the requests. */
function scriptedProvider(answers: readonly unknown[]) {
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    config: { baseUrl: "https://example.test", apiKey: "test", model: "test-model" },
    async chat(request): Promise<ChatResponse> {
      const answer = answers[requests.length] ?? answers[answers.length - 1];
      requests.push(request);
      return { message: { role: "assistant", content: JSON.stringify(answer) } };
    },
    async *chatStream() {
      return;
    },
  };
  return { provider, requests };
}

const requestText = (request: ChatRequest | undefined) => JSON.stringify(request ?? "");

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryProject(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "doxa-round3-"));
  temporaryDirectories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(directory, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return directory;
}

describe("a plan that the instructions empty", () => {
  const endpoint = (id: string, method: string, path: string) => ({
    id,
    title: id,
    method,
    path,
    description: `Use ${method} ${path} through the public REST API with the documented request contract.`,
    sourceEvidence: [{ path: `api/routes/${id}.ts`, kind: "source" as const }],
  });
  const withRestSurface: ProjectAnalysis = normalizeProjectAnalysis({
    ...analysisFixture,
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        description: "Manage webhooks through the public REST API.",
        sourceEvidence: [],
        groups: [{
          id: "webhooks",
          title: "Webhooks",
          description: "Create and list the webhooks that receive events.",
          sourceEvidence: [],
          endpoints: [endpoint("create-webhook", "POST", "/v1/webhooks"), endpoint("list-webhooks", "GET", "/v1/webhooks")],
        }],
      },
    },
  });
  const onlyExcluded = plan(page("alpha", "Alpha things", {
    pageType: "guides",
    sourceEvidence: [{ path: "src/a.ts", kind: "source" }],
  }));
  const brief = briefWith({ doNotDocument: ["src/**"] });

  test("with a REST surface, the planner retries with the removed pages instead of a defect error", async () => {
    const valid = plan(page("overview", "Overview", { pageType: "overview" }));
    const { provider, requests } = scriptedProvider([onlyExcluded, valid]);

    const structure = await generateStructureWithRetry(provider, {
      analysis: withRestSurface,
      answers: {},
      documentationBrief: brief,
    });

    expect(requests).toHaveLength(2);
    expect(requestText(requests[1])).toContain("\\\"Alpha things\\\" (its evidence is only under");
    expect(titlesOf(structure)).toContain("Overview");
  });

  test("with a REST surface, a planner that keeps failing ends in a normal failure after its attempts", async () => {
    const { provider, requests } = scriptedProvider([onlyExcluded]);

    const failure = await generateStructureWithRetry(provider, {
      analysis: withRestSurface,
      answers: {},
      documentationBrief: brief,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StructureGenerationFailedError);
    expect(failure).not.toBeInstanceOf(StructurePipelineDefectError);
    expect(requests).toHaveLength(3);
  });

  test("without a reference surface, it retries and then fails normally", async () => {
    const { provider, requests } = scriptedProvider([onlyExcluded]);

    const failure = await generateStructureWithRetry(provider, {
      analysis: normalizeProjectAnalysis(analysisFixture),
      answers: {},
      documentationBrief: brief,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StructureGenerationFailedError);
    expect(requests).toHaveLength(3);
  });
});

describe("a collection that loses an item of a type that is off", () => {
  const items = ["Alpha", "Beta", "Gamma", "Troubleshooting"];
  const analysis = normalizeProjectAnalysis({
    ...analysisFixture,
    documentationCollections: [{
      id: "topics",
      title: "Topics",
      kind: "mixed",
      sourceEvidence: [],
      items: items.map((title) => ({
        id: `topics/${title.toLowerCase()}`,
        slug: title.toLowerCase(),
        title,
        sourceEvidence: [{ path: `src/${title.toLowerCase()}.ts`, kind: "source" as const }],
      })),
    }],
  });

  test("still gives its other items their pages", () => {
    const applied = applyProjectInstructions(analysis, briefWith(NO_TROUBLESHOOTING));
    const structure = applyCollectionsToStructure(plan(page("overview", "Overview")), applied);

    expect(collectionsWithPages(applied).map((collection) => collection.id)).toEqual(["topics"]);
    expect(titlesOf(structure)).toEqual(expect.arrayContaining(["Alpha", "Beta", "Gamma"]));
    expect(titlesOf(structure)).not.toContain("Troubleshooting");
  });

  test("keeps the count through a checkpoint", () => {
    const applied = applyProjectInstructions(analysis, briefWith(NO_TROUBLESHOOTING));
    const restored = normalizeProjectAnalysis(JSON.parse(JSON.stringify(applied)));

    expect(restored.documentationCollections?.[0]?.turnedOffItemCount).toBe(1);
    expect(collectionsWithPages(restored)).toHaveLength(1);
  });

  test("ignores a count that the analysis model wrote", () => {
    const small = normalizeProjectAnalysis({
      ...analysisFixture,
      documentationCollections: [{
        id: "pair",
        title: "Pair",
        kind: "mixed",
        sourceEvidence: [],
        turnedOffItemCount: 10,
        items: ["One", "Two"].map((title) => ({
          id: `pair/${title.toLowerCase()}`,
          slug: title.toLowerCase(),
          title,
          sourceEvidence: [{ path: `src/${title.toLowerCase()}.ts`, kind: "source" as const }],
        })),
      }],
    });

    expect(collectionsWithPages(applyProjectInstructions(small, briefWith()))).toEqual([]);
    expect(collectionsWithPages(applyProjectInstructions(small, undefined))).toEqual([]);
  });
});

describe("page types that the planner declares", () => {
  test("a page without a declared type goes back to the planner while it has attempts left", async () => {
    const untyped = plan(page("overview", "Overview"), page("faq", "FAQ"));
    const typed = plan(page("overview", "Overview", { pageType: "overview" }), page("setup", "Set up", { pageType: "guides" }));
    const { provider, requests } = scriptedProvider([untyped, typed]);

    const structure = await generateStructureWithRetry(provider, {
      analysis: normalizeProjectAnalysis(analysisFixture),
      answers: {},
      documentationBrief: briefWith(NO_TROUBLESHOOTING),
    });

    expect(requests).toHaveLength(2);
    expect(requestText(requests[1])).toContain("Add pageType to these pages: \\\"Overview\\\", \\\"FAQ\\\"");
    expect(titlesOf(structure)).toEqual(expect.arrayContaining(["Overview", "Set up"]));
  });

  test("on the last attempt, the titles decide", async () => {
    const untyped = plan(page("overview", "Overview"), page("faq", "FAQ"), page("setup", "Set up"));
    const { provider, requests } = scriptedProvider([untyped]);
    const removed: PlanRemoval[][] = [];

    const structure = await generateStructureWithRetry(provider, {
      analysis: normalizeProjectAnalysis(analysisFixture),
      answers: {},
      documentationBrief: briefWith(NO_TROUBLESHOOTING),
      onPlanRemovals: (pages) => removed.push([...pages]),
    });

    expect(requests).toHaveLength(3);
    expect(titlesOf(structure)).not.toContain("FAQ");
    expect(removed).toEqual([[{ title: "FAQ", reason: { kind: "page_type", pageType: "troubleshooting" } }]]);
  });

  test("no page type off asks for no declaration", () => {
    expect(pagesMissingPageType(plan(page("faq", "FAQ")), briefWith())).toEqual([]);
    expect(pagesMissingPageType(plan(page("faq", "FAQ")), undefined)).toEqual([]);
  });

  test("a reference page and a collection item page need no declared type", () => {
    const reference = page("client", "Client", { reference: { kind: "sdk", moduleId: "client" } });
    const item = page("alpha", "Alpha", { collectionId: "topics", collectionItemId: "topics/alpha" });
    expect(pagesMissingPageType(plan(reference, item), briefWith(NO_TROUBLESHOOTING))).toEqual([]);
  });
});

describe("the title rule", () => {
  test("never removes the landing page", () => {
    const { structure, removed } = filterPlanByInstructions(
      plan(page("start", "Getting started"), page("install", "Quickstart")),
      briefWith({ pageTypes: ["guides", "reference", "concepts", "troubleshooting"] }),
    );

    expect(titlesOf(structure)).toEqual(["Getting started"]);
    expect(removed.map((item) => item.title)).toEqual(["Quickstart"]);
  });

  test("removes a title that names only types that are off, and keeps one that names a type that is on", () => {
    const { structure } = filterPlanByInstructions(
      plan(page("overview", "Overview"), page("style", "Style guide"), page("concepts", "API concepts guide")),
      briefWith(NO_GUIDES),
    );

    expect(titlesOf(structure)).toEqual(["Overview", "API concepts guide"]);
  });

  test("judges a reference page by its reference, not by a module named after a page type", () => {
    const core = page("core", "Core concepts", { reference: { kind: "sdk", moduleId: "core" } });
    const kept = filterPlanByInstructions(plan(page("overview", "Overview"), core), briefWith({ pageTypes: ["quickstart", "guides", "reference"] }));
    const referenceOff = filterPlanByInstructions(plan(page("overview", "Overview"), core), briefWith({ pageTypes: ["quickstart", "guides", "concepts"] }));

    expect(titlesOf(kept.structure)).toContain("Core concepts");
    expect(referenceOff.removed).toEqual([{ title: "Core concepts", reason: { kind: "page_type", pageType: "reference" } }]);
  });
});

describe("SDK module pages with concepts off", () => {
  test("stay mandatory, so the review keeps the pages that SDK coverage requires", () => {
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      referenceSurfaces: {
        sdk: {
          sourceEvidence: [],
          modules: [{ id: "core", title: "Core concepts", sourceEvidence: [{ path: "src/core.ts", kind: "source" }], exports: [] }],
        },
      },
    };
    const prompt = buildStructureReviewPrompt({
      analysis,
      structure: plan(page("overview", "Overview"), page("core", "Core concepts", { reference: { kind: "sdk", moduleId: "core" } })),
      maxPages: 10,
      documentationBrief: briefWith({ pageTypes: ["quickstart", "guides", "reference"] }),
    }).user;
    const coreEntry = prompt.slice(prompt.indexOf("\"title\": \"Core concepts\""));
    const nextEntry = coreEntry.indexOf("\"pageId\"");

    expect(nextEntry === -1 ? coreEntry : coreEntry.slice(0, nextEntry)).toContain("\"mandatory\": true");
  });
});

describe("the internal team as the reader", () => {
  test("keeps generated paths and secrets out of the evidence, and reads tests", async () => {
    const project = await temporaryProject({
      ".env": "SECRET_TOKEN=abc123",
      "dist/build.js": "GENERATED_BUNDLE",
      "tests/build.test.ts": "TEST_SUITE_FOR_BUILD",
    });
    const analysis = applyProjectInstructions(normalizeProjectAnalysis({
      ...analysisFixture,
      documentationIntent: {
        audience: "maintainer",
        primaryUseCase: "Build the product.",
        internalOnlyPaths: ["dist/"],
        consumerTerminology: [],
        canonicalWorkflows: [{
          name: "Build pipeline",
          steps: ["Run the build."],
          sourceEvidence: ["dist/build.js", "tests/build.test.ts"],
          requiredFiles: [],
        }],
      },
    }), briefWith({ audience: { reader: "internal", level: "expert" } }));

    const bundle = await buildPageEvidenceBundle({
      cwd: project,
      page: page("build", "Build pipeline", { sourceEvidence: [{ path: ".env", kind: "other" }] }),
      analysis,
    });

    expect(bundle.context).toContain("TEST_SUITE_FOR_BUILD");
    expect(bundle.context).not.toContain("GENERATED_BUNDLE");
    expect(bundle.context).not.toContain("SECRET_TOKEN");
  });
});

describe("navigation headings chosen by the ordering model", () => {
  test("a heading that names a type that is off takes the section label, and no page is lost", async () => {
    const outputDir = await temporaryProject({});
    const pageAt = (id: string, title: string): GeneratedPageContent => ({
      id,
      path: join(outputDir, "default", `${id}.mdx`),
      title,
      content: `---\ntitle: ${title}\n---\n\n${title} body.`,
      dependencies: { sourceFilesRead: [], sourceFilesDiscovered: [], sourceEvidenceFiles: [], referencedSymbols: [], referencedRoutes: [] },
      contentHash: "0".repeat(64),
      pageInputHash: "0".repeat(64),
    });
    const pages = [pageAt("overview", "Overview"), pageAt("deploy", "Deploy"), pageAt("setup", "Set up")];
    const manifestAnswer = {
      sections: [{
        slug: "default",
        groups: [
          { heading: "Documentation", items: ["default/overview.mdx"] },
          { heading: "Guides", items: ["default/deploy.mdx"] },
          { heading: "Operations", items: ["default/setup.mdx"] },
        ],
      }],
      icons: {},
      navTitles: {},
    };
    const { provider } = scriptedProvider([manifestAnswer]);

    await orderAndPersistNav({
      provider,
      pages,
      structure: plan(page("overview", "Overview"), page("deploy", "Deploy"), page("setup", "Set up")),
      fullOutputDir: outputDir,
      cwd: outputDir,
      documentationBrief: briefWith(NO_GUIDES),
    });
    const manifest = await readNavOrderManifest(outputDir);
    const section = manifest?.sections.find((entry) => entry.slug === "default");

    expect(section?.groups).toEqual([
      { heading: "Documentation", items: ["default/overview.mdx", "default/deploy.mdx"] },
      { heading: "Operations", items: ["default/setup.mdx"] },
    ]);
    expect(section?.items).toEqual(["default/overview.mdx", "default/deploy.mdx", "default/setup.mdx"]);
    expect(JSON.parse(await readFile(join(outputDir, ".nav-order.json"), "utf8")).sections).toHaveLength(1);
  });
});

describe("navigation groups without a heading to change", () => {
  async function orderedGroups(groups: readonly { heading: string; items: string[] }[], brief?: ReturnType<typeof briefWith>) {
    const outputDir = await temporaryProject({});
    const pageAt = (id: string, title: string): GeneratedPageContent => ({
      id,
      path: join(outputDir, "default", `${id}.mdx`),
      title,
      content: `---\ntitle: ${title}\n---\n\n${title} body.`,
      dependencies: { sourceFilesRead: [], sourceFilesDiscovered: [], sourceEvidenceFiles: [], referencedSymbols: [], referencedRoutes: [] },
      contentHash: "0".repeat(64),
      pageInputHash: "0".repeat(64),
    });
    const { provider } = scriptedProvider([{ sections: [{ slug: "default", groups }], icons: {}, navTitles: {} }]);
    await orderAndPersistNav({
      provider,
      pages: [pageAt("overview", "Overview"), pageAt("deploy", "Deploy"), pageAt("setup", "Set up")],
      structure: plan(page("overview", "Overview"), page("deploy", "Deploy"), page("setup", "Set up")),
      fullOutputDir: outputDir,
      cwd: outputDir,
      ...(brief ? { documentationBrief: brief } : {}),
    });
    return (await readNavOrderManifest(outputDir))?.sections.find((entry) => entry.slug === "default");
  }

  const modelGroups = [
    { heading: "Start", items: ["default/overview.mdx"] },
    { heading: "Operations", items: ["default/deploy.mdx"] },
    { heading: "Start", items: ["default/setup.mdx"] },
  ];

  test("a run without instructions keeps the model's groups and order exactly", async () => {
    const section = await orderedGroups(modelGroups);

    expect(section?.groups).toEqual(modelGroups);
    expect(section?.items).toEqual(["default/overview.mdx", "default/deploy.mdx", "default/setup.mdx"]);
  });

  test("a type that is off but named by no heading changes nothing", async () => {
    expect((await orderedGroups(modelGroups, briefWith(NO_GUIDES)))?.groups).toEqual(modelGroups);
  });

  test("a heading that also names a type that is on keeps its name", async () => {
    const groups = [
      { heading: "Documentation", items: ["default/overview.mdx"] },
      { heading: "Guides & Troubleshooting", items: ["default/deploy.mdx", "default/setup.mdx"] },
    ];

    expect((await orderedGroups(groups, briefWith(NO_TROUBLESHOOTING)))?.groups).toEqual(groups);
  });
});

describe("one title rule for plan pages, collection items, and nav headings", () => {
  const off = new Set<DoxabotPageType>(["troubleshooting"]);

  test.each([
    ["Troubleshooting", "troubleshooting"],
    ["FAQ", "troubleshooting"],
    ["Troubleshooting guide", undefined],
    ["Guides & Troubleshooting", undefined],
    ["Deploy", undefined],
  ])("%s names %s", (title, expected) => {
    expect(turnedOffTypeNamedBy(title, off)).toBe(expected);
    expect(turnedOffTypeOfPage({ title }, off)).toBe(expected);
    expect(headingNamesTurnedOffType(title, off)).toBe(expected !== undefined);
  });

  test("a collection item that is also a guide stays", () => {
    const analysis = normalizeProjectAnalysis({
      ...analysisFixture,
      documentationCollections: [{
        id: "topics",
        title: "Topics",
        kind: "mixed",
        sourceEvidence: [],
        items: ["Alpha", "Beta", "Troubleshooting guide", "Troubleshooting"].map((title) => ({
          id: `topics/${title.toLowerCase().replace(/\s+/g, "-")}`,
          slug: title.toLowerCase().replace(/\s+/g, "-"),
          title,
          sourceEvidence: [{ path: `src/${title.length}.ts`, kind: "source" as const }],
        })),
      }],
    });

    const items = applyProjectInstructions(analysis, briefWith(NO_TROUBLESHOOTING)).documentationCollections?.[0]?.items;
    expect(items?.map((item) => item.title)).toEqual(["Alpha", "Beta", "Troubleshooting guide"]);
  });
});

describe("which injection errors go back to the planner", () => {
  test("errors that appear only in the filtered plan are caused by the removals", () => {
    expect(areErrorsCausedByRemovals(["first section must be Documentation"], [])).toBe(true);
  });

  test("an error that injection causes in the unfiltered plan too stays a defect", () => {
    expect(areErrorsCausedByRemovals(
      ["first section must be Documentation", "reference page has no endpoint"],
      ["reference page has no endpoint"],
    )).toBe(false);
  });

  test("no errors is never a revision", () => {
    expect(areErrorsCausedByRemovals([], [])).toBe(false);
  });

  test("an error that names another count in the unfiltered plan is the same defect", () => {
    expect(areErrorsCausedByRemovals(
      ["Structure contains 3 package-script-like pages"],
      ["Structure contains 5 package-script-like pages"],
    )).toBe(false);
  });

  test("injection that fails on the unfiltered plan is a defect, never the removals' doing", () => {
    expect(areErrorsCausedByRemovals(["first section must be Documentation"], null)).toBe(false);
  });
});
