import { describe, expect, test } from "vitest";
import {
  descriptionPartPrompt,
  detectProjectProfile,
  prompts,
  validateDocumentationStructureForProfile,
} from "../src/doxa-agent/prompts";
import { composePrompt } from "../src/doxa-agent/prompts/dynamic/composer";
import { WRITER_FINALIZATION_PROMPT } from "../src/doxa-agent/prompts/system";
import type { PromptContext } from "../src/doxa-agent/prompts";
import {
  formatWriterHandoffPageForPrompt,
  formatWriterHandoffSharedForPrompt,
  resolveDocumentationBrief,
} from "../src";
import type {
  DocumentationStructure,
  ProjectAnalysis,
  WriterHandoffManifest,
} from "../src";
import { analysisFixture, structureFixture } from "./fixtures";

const documentTypes = [
  "overview",
  "gettingStarted",
  "architecture",
  "apiReference",
  "cliReference",
  "concept",
  "guide",
  "configuration",
  "provider",
];

function expectBuiltPrompt(value: { system: string; user: string }) {
  expect(value.system.trim().length).toBeGreaterThan(20);
  expect(value.user.trim().length).toBeGreaterThan(20);
}

const promptContext: PromptContext = {
  projectName: "Fixture",
  projectPath: "/fixture",
  languages: ["TypeScript"],
  files: [
    {
      path: "/fixture/src/index.ts",
      relativePath: "src/index.ts",
      content: "export function createFixture() {}",
      extension: ".ts",
      size: 34,
    },
  ],
  totalFiles: 1,
  answers: {
    title: "Fixture Docs",
    description: "Documentation for a fixture package.",
  },
  packageJson: "{\"name\":\"fixture\"}",
  readme: "# Fixture",
};

function analysisFor(category: ProjectAnalysis["projectCategory"], overrides: Partial<ProjectAnalysis> = {}): ProjectAnalysis {
  return {
    ...analysisFixture,
    projectCategory: category,
    hasCli: category === "cli",
    hasApiRoutes: category === "api",
    isMonorepo: category === "monorepo",
    ...overrides,
  };
}

function writerPromptForPage(input: {
  id: string;
  title: string;
  description: string;
  pageTypeInstructions: string;
  relevantContext: string;
  sourceEvidenceContext: string;
  retryHint: string;
}) {
  const analysis: ProjectAnalysis = {
    ...analysisFixture,
    publicEditorialBrief: {
      intendedReaders: ["Shared reader marker"],
      readerGoals: ["Shared reader goal"],
      focusAreas: ["Shared focus area"],
      deprioritizedAreas: [],
      preferredTerminology: [],
    },
  };
  return prompts.buildWriterPrompt({
    analysis,
    sectionTitle: "Documentation",
    page: {
      id: input.id,
      title: input.title,
      description: input.description,
    },
    structure: structureFixture,
    pageType: "test-page-type",
    pageTypeInstructions: input.pageTypeInstructions,
    descriptionInstructions: "SHARED DESCRIPTION INSTRUCTIONS",
    relevantContext: input.relevantContext,
    sourceEvidenceContext: input.sourceEvidenceContext,
    routeRegistryContext: "SHARED CANONICAL ROUTE /overview",
    writerHandoffSharedContext:
      formatWriterHandoffSharedForPrompt(writerHandoffFixture),
    writerHandoffPageContext:
      formatWriterHandoffPageForPrompt(writerHandoffFixture, input.id),
    componentPlaybook: "SHARED COMPONENT PLAYBOOK",
    documentationBrief: resolveDocumentationBrief({
      target: { kind: "public" },
    }),
    retryHint: input.retryHint,
  });
}

const writerHandoffFixture: WriterHandoffManifest = {
  schemaVersion: 1,
  sourceRevision: "a".repeat(40),
  project: {
    name: "SHARED PROJECT HANDOFF MARKER",
    slug: "fixture",
    audience: "SDK consumers",
    documentationGoal: "Help readers adopt the SDK.",
  },
  shared: {
    terminology: ["SHARED TERMINOLOGY MARKER"],
    factualConstraints: ["Use repository evidence."],
    editorialConstraints: ["Write for SDK consumers."],
    validationConstraints: ["Return complete MDX."],
  },
  pages: [
    {
      pageId: "alpha-marker",
      title: "Alpha",
      route: "/alpha",
      pageType: "documentation",
      purpose: "Explain alpha.",
      requiredTopics: ["ALPHA HANDOFF TOPIC"],
      sourceEvidence: [],
      relatedPageIds: [],
      exclusions: [],
    },
    {
      pageId: "beta-marker",
      title: "Beta",
      route: "/beta",
      pageType: "documentation",
      purpose: "Explain beta.",
      requiredTopics: ["BETA HANDOFF TOPIC"],
      sourceEvidence: [],
      relatedPageIds: [],
      exclusions: [],
    },
  ],
};

describe("prompt registry", () => {
  test("requires evidence-backed plain-English REST endpoint titles", () => {
    const prompt = prompts.buildAnalysisPrompt({
      explorationContext: "Public Fastify routes and an OpenAPI 3.1 schema.",
    });

    expect(prompt.user).toContain("2 to 5 words");
    expect(prompt.user).toContain("Never put the HTTP method, the URL path");
    expect(prompt.user).toContain("Titles must be unique within their group");
    expect(prompt.user).toContain("Prefer an OpenAPI specification");
    expect(prompt.system).toContain('"authSchemes"');
    const apiPrompt = prompts.buildAnalysisPrompt({
      analysis: analysisFor("api"),
      explorationContext: "Public Fastify routes and an OpenAPI 3.1 schema.",
    });
    expect(apiPrompt.system).toContain(
      "Put every auth scheme the API accepts in referenceSurfaces.rest.authSchemes",
    );

    const writerPrompt = writerPromptForPage({
      id: "alpha-marker",
      title: "Get a user",
      description: "Return one public user.",
      pageTypeInstructions: "REST endpoint prose.",
      relevantContext: "GET /users/{userId}",
      sourceEvidenceContext: "src/routes/users.ts",
      retryHint: "",
    });
    expect(writerPrompt.system).toContain("must not author them by hand");
    expect(writerPrompt.system).toContain("ApiEndpoint");
    expect(writerPrompt.system).toContain("parameter tables are generated deterministically");
  });

  test("registers every expected document template type", () => {
    expect(prompts.getDocumentTypes().sort()).toEqual(documentTypes.sort());
  });

  test("builds dynamic prompts for all agent stages", () => {
    const page = structureFixture.sections[0].pages[0];

    expectBuiltPrompt(prompts.buildExplorationPrompt({ cwd: "/fixture" }));
    expectBuiltPrompt(prompts.buildAnalysisPrompt({ explorationContext: "README and package metadata found." }));
    const structurePrompt = prompts.buildStructurePrompt({
      analysis: analysisFixture,
      answers: {},
      maxPages: 18,
    });
    expectBuiltPrompt(structurePrompt);
    expect(structurePrompt.user).toContain(
      "EDITORIAL PAGE BUDGET: at most 18 guide, concept, and workflow pages.\nReference pages generated from the project's API surface do not count toward this budget and must not be dropped to satisfy it.",
    );
    expect(structurePrompt.system).toContain(
      "REST API reference: create one page per endpoint. Each page covers exactly one HTTP method and path. The generator adds the section overview page, the authentication page, and one resource page per endpoint group. Do not author those pages yourself.",
    );
    expect(structurePrompt.system).toContain(
      "SDK reference: keep one page per public module. Cover exports, classes, and members inside that page; never create one page per symbol.",
    );
    const reviewPrompt = prompts.buildStructureReviewPrompt({
      analysis: analysisFixture,
      structure: structureFixture,
      maxPages: 12,
    });
    expectBuiltPrompt(reviewPrompt);
    expect(reviewPrompt.user).toContain(
      "EDITORIAL PAGE BUDGET: at most 12 guide, concept, and workflow pages.\nReference pages generated from the project's API surface do not count toward this budget and must not be dropped to satisfy it.",
    );
    expectBuiltPrompt(prompts.buildWriterPrompt({
      analysis: analysisFixture,
      sectionTitle: "Documentation",
      page,
      structure: structureFixture,
      pageType: "overview",
    }));
    expectBuiltPrompt(prompts.buildGenericWriterPrompt({
      title: "Troubleshooting",
      description: "Common operational fixes.",
      analysis: analysisFixture,
    }));
    expectBuiltPrompt(prompts.buildIncrementalAnalysisPrompt({
      previousAnalysis: analysisFixture,
      changedFiles: ["src/index.ts"],
      addedFiles: [],
      deletedFiles: [],
      fileContents: ["=== src/index.ts ===\nexport function createFixture() {}"],
    }));
    expectBuiltPrompt(prompts.buildOrderingPrompt({
      orderingInput: {
        sections: [{ slug: "default", label: "Documentation", isDefault: true }],
        docs: [{ section: "default", filename: "default/overview/index.mdx", title: "Overview", head: "# Overview" }],
      },
    }));
  });

  test("describes REST inventory as endpoint pages grouped only in navigation", () => {
    const prompt = prompts.buildStructurePrompt({
      analysis: analysisFor("api", {
        referenceSurfaces: {
          rest: {
            label: "REST API",
            slug: "rest-api",
            sourceEvidence: [],
            groups: [{
              id: "widgets",
              title: "Widgets",
              sourceEvidence: [{ path: "src/routes/widgets.ts" }],
              endpoints: ["GET", "POST"].map((method) => ({
                id: `${method.toLowerCase()}-widgets`,
                title: `${method} /widgets`,
                method,
                path: "/widgets",
                description: `${method} public widgets.`,
                sourceEvidence: [{ path: "src/routes/widgets.ts" }],
              })),
            }],
          },
        },
      }),
      answers: {},
      maxPages: 24,
    });

    expect(prompt.user).toContain(
      "- Widgets: 2 endpoints; plan one page per endpoint and use the resource group only as a navigation heading",
    );
    expect(prompt.user).not.toContain("group parent page");
  });

  test("reserves REST and SDK references for dedicated reference surfaces", () => {
    const prompt = prompts.buildAnalysisPrompt({
      explorationContext: "Public endpoints and exports found.",
    });

    expect(prompt.user).toContain(
      "documentationCollections must NOT restate reference surfaces.",
    );
    expect(prompt.user).toContain(
      "HTTP/RPC endpoints belong in referenceSurfaces.rest and SDK exports belong in referenceSurfaces.sdk.",
    );
    expect(prompt.user).toContain(
      "Collections are for repeated non-reference surfaces such as providers, adapters, integrations, plugins, or command families.",
    );
  });

  test("builds every legacy template prompt", () => {
    for (const type of documentTypes) {
      expectBuiltPrompt(prompts.buildTemplatePrompt(type, promptContext));
    }
  });

  test("keeps a byte-identical shared writer prefix and all page-specific context", () => {
    const first = writerPromptForPage({
      id: "alpha-marker",
      title: "ALPHA PAGE TITLE",
      description: "ALPHA PAGE DESCRIPTION",
      pageTypeInstructions: "ALPHA PAGE TYPE INSTRUCTIONS",
      relevantContext: "ALPHA RELEVANT CONTEXT",
      sourceEvidenceContext: "ALPHA SOURCE EVIDENCE",
      retryHint: "ALPHA RETRY HINT",
    });
    const second = writerPromptForPage({
      id: "beta-marker",
      title: "BETA PAGE TITLE",
      description: "BETA PAGE DESCRIPTION",
      pageTypeInstructions: "BETA PAGE TYPE INSTRUCTIONS",
      relevantContext: "BETA RELEVANT CONTEXT",
      sourceEvidenceContext: "BETA SOURCE EVIDENCE",
      retryHint: "BETA RETRY HINT",
    });

    expect(first.system).toBe(second.system);
    for (const sharedSection of [
      "PROJECT CONTEXT:",
      "FULL DOCUMENTATION STRUCTURE:",
      "CANONICAL GENERATED ROUTES:",
      "PUBLIC EDITORIAL BRIEF:",
      "SHARED DESCRIPTION INSTRUCTIONS",
      "SHARED COMPONENT PLAYBOOK",
      "Shared reader marker",
      "SHARED CANONICAL ROUTE /overview",
      "SHARED PROJECT HANDOFF MARKER",
      "SHARED TERMINOLOGY MARKER",
    ]) {
      expect(first.system).toContain(sharedSection);
    }

    for (const pageSpecificToken of [
      "ALPHA PAGE TITLE",
      "ALPHA PAGE DESCRIPTION",
      "ALPHA PAGE TYPE INSTRUCTIONS",
      "ALPHA SOURCE EVIDENCE",
      "ALPHA HANDOFF TOPIC",
      "ALPHA RETRY HINT",
    ]) {
      expect(first.system).not.toContain(pageSpecificToken);
      expect(first.user).toContain(pageSpecificToken);
    }
    expect(first.user).not.toContain("BETA HANDOFF TOPIC");
    expect(second.user).not.toContain("ALPHA HANDOFF TOPIC");
    expect(first.user).not.toContain("SHARED PROJECT HANDOFF MARKER");
    expect(second.user).not.toContain("SHARED TERMINOLOGY MARKER");

    const combined = `${first.system}\n${first.user}`;
    for (const preservedSection of [
      "PROJECT CONTEXT:",
      "RELEVANT DATA FOR THIS PAGE:",
      "SOURCE EVIDENCE FOR THIS PAGE:",
      "CANONICAL GENERATED ROUTES:",
      "FULL DOCUMENTATION STRUCTURE:",
      "PUBLIC EDITORIAL BRIEF:",
      "Instructions:",
      "ALPHA RELEVANT CONTEXT",
    ]) {
      expect(combined).toContain(preservedSection);
    }
  });

  test("contains raw project context to exploration and full analysis", () => {
    const documentationBrief = resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: "Use a concise expert tone and focus on SDK adopters.",
    });
    const exploration = prompts.buildExplorationPrompt({ cwd: "/fixture", documentationBrief });
    const analysis = prompts.buildAnalysisPrompt({
      explorationContext: "README and package metadata found.",
      documentationBrief,
    });

    expect(exploration.user).toContain("USER-PROVIDED PROJECT CONTEXT");
    expect(exploration.user).toContain("focus on SDK adopters");
    expect(analysis.user).toContain("USER-PROVIDED PROJECT CONTEXT");
    expect(analysis.user).toContain("focus on SDK adopters");
    expect(exploration.system).toContain("PUBLIC DOCUMENTATION POLICY");
  });

  test("passes normalized editorial guidance downstream without raw context", () => {
    const documentationBrief = resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: "RAW PRIVATE MARKER",
    });
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      publicEditorialBrief: {
        intendedReaders: ["SDK developers"],
        readerGoals: ["Integrate the client"],
        focusAreas: ["Authentication"],
        deprioritizedAreas: ["Repository internals"],
        preferredTone: "Concise and expert",
        preferredTerminology: ["workspace"],
      },
    };
    const page = structureFixture.sections[0].pages[0];
    const structure = prompts.buildStructurePrompt({ analysis, answers: {}, documentationBrief });
    const writer = prompts.buildWriterPrompt({
      analysis,
      sectionTitle: "Documentation",
      page,
      structure: structureFixture,
      documentationBrief,
    });

    const ordering = prompts.buildOrderingPrompt({
      analysis,
      documentationBrief,
      orderingInput: {
        sections: [{ slug: "default", label: "Documentation", isDefault: true }],
        docs: [{ section: "default", filename: "default/overview.md", title: "Overview", head: "Overview" }],
      },
    });

    for (const prompt of [structure, ordering]) {
      expect(prompt.user).toContain("PUBLIC EDITORIAL BRIEF");
      expect(prompt.user).toContain("SDK developers");
      expect(prompt.user).not.toContain("RAW PRIVATE MARKER");
      expect(prompt.system).toContain("PUBLIC DOCUMENTATION POLICY");
    }
    expect(writer.system).toContain("PUBLIC EDITORIAL BRIEF");
    expect(writer.system).toContain("SDK developers");
    expect(writer.system).not.toContain("RAW PRIVATE MARKER");
    expect(writer.system).toContain("PUBLIC DOCUMENTATION POLICY");
  });
});

test("the ordering prompt offers each page its Lucide icon candidates", () => {
  const ordering = prompts.buildOrderingPrompt({
    orderingInput: {
      sections: [{ slug: "default", label: "Documentation", isDefault: true }],
      docs: [
        {
          section: "default",
          filename: "default/webhooks.md",
          title: "Webhooks",
          head: "Receive events",
          iconCandidates: ["webhook", "send"],
        },
        { section: "default", filename: "default/overview.md", title: "Overview", head: "Overview" },
      ],
      iconCatalog: "Suggested icons (prefer one when it fits the page):\n- rocket: Launch.",
    },
  });

  expect(ordering.user).toContain("title: Webhooks\n  head: Receive events\n  icon candidates: webhook, send");
  expect(ordering.user).not.toContain("title: Overview\n  head: Overview\n  icon candidates");
  expect(ordering.user).toContain("ICONS (choose exactly one per filename):\nSuggested icons");
  expect(ordering.user).toContain("one of the page's icon candidates, or another real Lucide icon name");
});

test("writer finalization requires a complete page without tool commentary", () => {
  expect(WRITER_FINALIZATION_PROMPT).toContain("Tools are disabled");
  expect(WRITER_FINALIZATION_PROMPT).toContain("COMPLETE MDX");
  expect(WRITER_FINALIZATION_PROMPT).toContain("first character");
  expect(WRITER_FINALIZATION_PROMPT).toContain("Do not mention");
  expect(WRITER_FINALIZATION_PROMPT).not.toContain("remaining tasks");
});

describe("prompt validators", () => {
  test("accepts a minimal valid documentation structure", () => {
    const validStructure: DocumentationStructure = {
      sections: [
        {
          id: "documentation",
          title: "Documentation",
          default: true,
          pages: [
            {
              id: "overview",
              title: "Overview",
              description: "Understand the fixture package purpose, setup path, and primary user-facing workflow.",
              sourceEvidence: [{ path: "README.md" }],
            },
          ],
        },
      ],
    };

    expect(validateDocumentationStructureForProfile(validStructure, analysisFixture)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("validates and fixes description part prompt values", () => {
    const result = prompts.validatePartValue(
      descriptionPartPrompt,
      "Learn how to configure deployment pipelines for production environments with lots of unnecessary trailing words",
    );

    expect(result.valid).toBe(false);
    expect(result.fixed).toMatch(/^Configure/);
    expect(result.fixed.split(/\s+/).length).toBeLessThanOrEqual(20);
  });

  test("detects CLI, API, library, and fallback profiles", () => {
    expect(detectProjectProfile(analysisFor("cli")).id).toBe("cli");
    expect(detectProjectProfile(analysisFor("api")).id).toBe("api");
    expect(detectProjectProfile(analysisFor("library")).id).toBe("library");
    expect(detectProjectProfile(analysisFor("other", {
      projectType: "unknown",
      summary: "Small project",
      projectDescription: "Small project",
      frameworks: [],
      keyFeatures: [],
      entryPoints: [],
      keyFiles: [],
    })).id).toBe("fallback");
  });

  test("composes prompt modules deterministically", () => {
    const prompt = composePrompt({
      stage: "writer",
      context: { analysis: analysisFixture },
      systemIntro: "Intro",
      userBody: "User body",
      modules: [
        { id: "b", stage: "writer", priority: 20, render: () => "Second" },
        { id: "a", stage: "writer", priority: 10, render: () => "First" },
      ],
    });

    expect(prompt.system).toBe("Intro\n\nFirst\n\nSecond");
    expect(prompt.user).toBe("User body");
  });
});
