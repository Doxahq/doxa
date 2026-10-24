import { describe, expect, test } from "vitest";
import type { ChatRequest, ChatResponse, ChatStreamEvent, Provider } from "../src/core";
import {
  applyStructureReviewDecisions,
  editorialPageCount,
  reviewStructureWithRetry,
  StructureReviewFailedError,
  validateReviewedStructure,
} from "../src/doxa-agent/structure-review";
import { validateDocumentationStructureForProfile } from "../src/doxa-agent/prompts/dynamic";
import type { StructureReviewOperations } from "../src/doxa-agent/structure-review";
import { generateStructureWithRetry } from "../src/doxa-agent/structure-runner";
import type {
  DocumentationCollection,
  DocumentationStructure,
  ProjectAnalysis,
} from "../src";
import {
  StructureInfeasibleConstraintsError,
  StructurePipelineDefectError,
} from "../src/doxa-agent/structure-review-errors";
import { prompts } from "../src/doxa-agent/prompts";
import { analysisFixture } from "./fixtures";

function reviewFixture(): DocumentationStructure {
  return {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          {
            id: "overview",
            title: "Overview",
            description: "Understand the public product and its primary user workflows.",
          },
          {
            id: "memory-bank",
            title: "Memory Bank",
            description: "Use persistent project context across supported developer tools.",
          },
          {
            id: "memory-bank-files",
            title: "Memory Bank Files",
            description: "Understand each context file, its purpose, and its persistent lifecycle.",
          },
        ],
      },
      {
        id: "development",
        title: "Development",
        pages: [
          {
            id: "test-endpoint",
            title: "Test Endpoint",
            description: "Call the repository-only diagnostic route during local development.",
          },
        ],
      },
    ],
  };
}

const validDecisions = [
  { action: "keep", pageId: "documentation/overview", reason: "Primary entry point" },
  { action: "keep", pageId: "documentation/memory-bank", reason: "Public user concept" },
  {
    action: "merge",
    pageId: "documentation/memory-bank-files",
    targetPageId: "documentation/memory-bank",
    reason: "Same reader goal",
  },
  { action: "drop", pageId: "development/test-endpoint", reason: "Internal diagnostic" },
] as const;

function collectionFixture(title: string, itemCount: number): DocumentationCollection {
  const id = title.toLowerCase().replace(/\s+/g, "-");
  return {
    id,
    title,
    kind: "docs",
    sourceEvidence: [{ path: `docs/${id}` }],
    items: Array.from({ length: itemCount }, (_, index) => {
      const itemNumber = index + 1;
      return {
        id: `${id}/item-${itemNumber}`,
        slug: `item-${itemNumber}`,
        title: `Item ${itemNumber}`,
        sourceEvidence: [{ path: `docs/${id}/item-${itemNumber}.md` }],
      };
    }),
  };
}

function fixtureWithCollection(
  collection: DocumentationCollection,
): DocumentationStructure {
  const structure = reviewFixture();
  structure.sections[0]?.pages.push(...collection.items.map((item) => ({
      id: `${collection.id}/${item.slug}`,
      title: item.title,
      description: `Understand ${item.title.toLowerCase()} and apply it in the supported public workflow. Follow its evidence-backed setup and usage guidance.`,
      group: collection.title,
      collectionId: collection.id,
      collectionItemId: item.id,
      sourceEvidence: item.sourceEvidence,
  })));
  return structure;
}

function structureWithReferenceAndProsePages(
  referencePageCount: number,
  prosePageCount: number,
): DocumentationStructure {
  const referencePages = Array.from({ length: referencePageCount }, (_, index) => ({
    id: `endpoint-${index + 1}`,
    title: `Endpoint ${index + 1}`,
    description: `Use public endpoint ${index + 1} from the API reference.`,
    reference: { kind: "rest" as const, endpointId: `endpoint-${index + 1}` },
  }));

  return {
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        ...referencePages,
        ...Array.from({ length: prosePageCount }, (_, index) => ({
          id: `guide-${index + 1}`,
          title: `Guide ${index + 1}`,
          description: `Complete guide ${index + 1} for a distinct public workflow.`,
        })),
      ],
    }],
  };
}

function reviewWithOperations(
  provider: Provider,
  input: Parameters<typeof reviewStructureWithRetry>[1],
  operations: StructureReviewOperations,
): ReturnType<typeof reviewStructureWithRetry> {
  return reviewStructureWithRetry(
    provider,
    input,
    undefined,
    prompts,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    operations,
  );
}

class SequenceProvider implements Provider {
  readonly config = { baseUrl: "https://example.test", apiKey: "test", model: "test-model" };
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: this.responses.shift() ?? "",
      },
    };
  }

  async *chatStream(_request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    return;
  }
}

describe("public structure review", () => {
  test("counts only prose when reference and collection pages are grouped", () => {
    const structure: DocumentationStructure = {
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          {
              id: "get-widgets",
              title: "Get widgets",
              description: "Fetch public widget records.",
              group: "Widgets API",
              reference: {
                kind: "rest",
                groupId: "widgets",
                endpointId: "get-widgets",
              },
          },
          {
            id: "providers/alpha",
            title: "Alpha provider",
            description: "Configure the Alpha provider.",
            group: "Providers",
            collectionId: "providers",
            collectionItemId: "providers/alpha",
          },
          {
            id: "quickstart",
            title: "Quickstart",
            description: "Complete the primary public setup workflow.",
          },
          {
              id: "quickstart/verify",
              title: "Verify setup",
              description: "Verify the completed setup workflow.",
              group: "Quickstart",
          },
        ],
      }],
    };

    expect(editorialPageCount(structure)).toBe(2);
  });

  test("accepts 29 reference pages alongside 20 prose pages within a 36-page editorial budget", () => {
    const structure = structureWithReferenceAndProsePages(29, 20);

    expect(editorialPageCount(structure)).toBe(20);
    expect(validateReviewedStructure(structure, 36)).toEqual({ valid: true, errors: [] });
  });

  test("rejects 40 prose pages even when reference inventory is exempt", () => {
    const structure = structureWithReferenceAndProsePages(29, 40);

    expect(validateReviewedStructure(structure, 36)).toEqual({
      valid: false,
      errors: ["Reviewed structure has 40 editorial pages; editorial budget is 36."],
    });
  });

  test("accepts any number of reference pages beside the editorial budget", () => {
    const structure = structureWithReferenceAndProsePages(500, 36);

    expect(validateReviewedStructure(structure, 36)).toEqual({ valid: true, errors: [] });
  });

  test("merges duplicate pages and drops internal-only pages", () => {
    const reviewed = applyStructureReviewDecisions(reviewFixture(), validDecisions);

    expect(reviewed.sections).toHaveLength(1);
    expect(reviewed.sections[0]?.pages.map((page) => page.title)).toEqual(["Overview", "Memory Bank"]);
    expect(reviewed.sections[0]?.pages[1]?.description).toContain("Memory Bank Files");
    expect(reviewed.sections[0]?.pages[1]?.description).not.toContain(
      "Understand each context file, its purpose",
    );
    expect(validateReviewedStructure(reviewed, 2)).toEqual({ valid: true, errors: [] });
  });

  test("keeps a long target brief whole and adds the merged topic after it", () => {
    const longBrief =
      "Self-hosted FlagForge HTTP API for managing projects, environments, flags, segments, webhooks and audit logs, " +
      "and for evaluating flags. Management endpoints require a server key; evaluation endpoints require a " +
      'project-scoped client key. Errors use the envelope { "error": { "code", "message" } }.';
    const fixture = reviewFixture();
    fixture.sections[0]!.pages[1]!.description = longBrief;

    const reviewed = applyStructureReviewDecisions(fixture, validDecisions);

    expect(reviewed.sections[0]?.pages[1]?.description).toBe(
      `${longBrief} Include Memory Bank Files within this same reader workflow.`,
    );
  });

  test("rejects incomplete decisions and invalid merge targets", () => {
    expect(() => applyStructureReviewDecisions(reviewFixture(), [validDecisions[0]])).toThrow(/decision.*every page/i);
    expect(() => applyStructureReviewDecisions(reviewFixture(), [
      ...validDecisions.slice(0, 2),
      {
        action: "merge",
        pageId: "documentation/memory-bank-files",
        targetPageId: "documentation/missing",
        reason: "Invalid destination",
      },
      validDecisions[3],
    ])).toThrow(/target.*does not exist/i);
  });

  test("retries with actionable validation feedback", async () => {
    const provider = new SequenceProvider([
      JSON.stringify({ decisions: [{ action: "keep", pageId: "documentation/overview", reason: "Keep" }] }),
      JSON.stringify({ decisions: validDecisions }),
    ]);

    const reviewed = await reviewStructureWithRetry(provider, {
      analysis: analysisFixture,
      structure: reviewFixture(),
      maxPages: 2,
    });

    expect(provider.requests).toHaveLength(2);
    const secondUserMessage = provider.requests[1]?.messages.find((message) => message.role === "user");
    expect(secondUserMessage?.content).toMatch(/previous review was rejected/i);
    expect(secondUserMessage?.content).toMatch(/decision.*every page/i);
    expect(validateReviewedStructure(reviewed, 2).valid).toBe(true);
  });

  test("fails after one model call when decision application introduces duplicate IDs", async () => {
    const provider = new SequenceProvider([JSON.stringify({ decisions: validDecisions })]);
    const operations: StructureReviewOperations = {
      applyDecisions: (structure, decisions) => {
        const reviewed = applyStructureReviewDecisions(structure, decisions);
        reviewed.sections[0]?.pages.push({
          id: "overview",
          title: "Duplicate overview",
          description: "A pipeline-created duplicate page.",
        });
        return reviewed;
      },
    };

    await expect(reviewWithOperations(provider, {
      analysis: analysisFixture,
      structure: reviewFixture(),
      maxPages: 10,
    }, operations)).rejects.toEqual(expect.objectContaining({
      name: "StructurePipelineDefectError",
      kind: "pipeline_defect",
      message: expect.stringMatching(/decision application.*documentation\/overview.*defect/is),
    } satisfies Partial<StructurePipelineDefectError>));
    expect(provider.requests).toHaveLength(1);
  });

  test("retries malformed model output twice before succeeding on attempt three", async () => {
    const provider = new SequenceProvider([
      "not JSON",
      "{",
      JSON.stringify({ decisions: validDecisions }),
    ]);

    const reviewed = await reviewStructureWithRetry(provider, {
      analysis: analysisFixture,
      structure: reviewFixture(),
      maxPages: 2,
    });

    expect(provider.requests).toHaveLength(3);
    expect(validateReviewedStructure(reviewed, 2).valid).toBe(true);
  });

  test("preserves model-output exhaustion after three attempts", async () => {
    const provider = new SequenceProvider(["not JSON", "still not JSON", "{"]);

    await expect(reviewStructureWithRetry(provider, {
      analysis: analysisFixture,
      structure: reviewFixture(),
      maxPages: 2,
    })).rejects.toEqual(expect.objectContaining({
      name: "StructureReviewFailedError",
      attempts: 3,
    } satisfies Partial<StructureReviewFailedError>));
    expect(provider.requests).toHaveLength(3);
  });

  test("falls back to the last budget-only review candidate and emits degradation", async () => {
    const degradedErrors: string[][] = [];
    const structure: DocumentationStructure = {
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          {
            id: "overview",
            title: "Overview",
            description: "Understand the product and its primary user-facing capabilities.",
          },
          {
            id: "setup",
            title: "Setup",
            description: "Install and configure the product for a first successful use.",
          },
          {
            id: "configuration",
            title: "Configuration",
            description: "Configure the product for the needs of a production application.",
          },
          {
            id: "troubleshooting",
            title: "Troubleshooting",
            description: "Resolve common problems when using the product in an application.",
          },
        ],
      }],
    };
    const keepDecisions = structure.sections.flatMap((section) => section.pages.map((page) => ({
      action: "keep" as const,
      pageId: `${section.id}/${page.id}`,
      reason: "Needed for the public reader journey",
    })));
    const provider = new SequenceProvider([
      JSON.stringify({ decisions: keepDecisions }),
      JSON.stringify({ decisions: keepDecisions }),
      JSON.stringify({ decisions: keepDecisions }),
    ]);
    const input = {
      analysis: analysisFixture,
      structure,
      maxPages: 3,
      onDegraded: (errors: string[]) => {
        degradedErrors.push(errors);
      },
    };

    const reviewed = await reviewStructureWithRetry(provider, input);

    expect(reviewed).toEqual(structure);
    expect(degradedErrors).toEqual([[
      "Reviewed structure has 4 editorial pages; editorial budget is 3.",
    ]]);
    expect(provider.requests).toHaveLength(3);
  });

  test("falls back to the original proposal after parseable invalid review decisions", async () => {
    const degradedErrors: string[][] = [];
    const structure = reviewFixture();
    const provider = new SequenceProvider([
      JSON.stringify({
        decisions: [{
          action: "keep",
          pageId: "documentation/overview",
          reason: "Incomplete review response",
        }],
      }),
      JSON.stringify({
        decisions: [{
          action: "keep",
          pageId: "documentation/overview",
          reason: "Incomplete review response",
        }],
      }),
      JSON.stringify({
        decisions: [{
          action: "keep",
          pageId: "documentation/overview",
          reason: "Incomplete review response",
        }],
      }),
    ]);

    const reviewed = await reviewStructureWithRetry(provider, {
      analysis: analysisFixture,
      structure,
      maxPages: 10,
      onDegraded: (errors) => {
        degradedErrors.push(errors);
      },
    });

    expect(reviewed).toEqual(structure);
    expect(degradedErrors).toEqual([[
      "Structure review must provide exactly one decision for every page.",
    ]]);
    expect(provider.requests).toHaveLength(3);
  });

  test("reviews a mandatory inventory that is larger than the editorial budget", async () => {
    const provider = new SequenceProvider([]);
    const domainConcepts = collectionFixture("Domain concepts", 8);
    const publicPackages = collectionFixture("Public packages", 13);

    await expect(reviewStructureWithRetry(provider, {
      analysis: {
        ...analysisFixture,
        documentationCollections: [domainConcepts, publicPackages],
      },
      structure: reviewFixture(),
      maxPages: 20,
    })).rejects.not.toBeInstanceOf(StructureInfeasibleConstraintsError);
    expect(provider.requests.length).toBeGreaterThan(0);
  });

  test("plans a structure for a mandatory inventory that is larger than the editorial budget", async () => {
    const provider = new SequenceProvider([]);
    const domainConcepts = collectionFixture("Domain concepts", 8);
    const publicPackages = collectionFixture("Public packages", 13);

    await expect(generateStructureWithRetry(provider, {
      analysis: {
        ...analysisFixture,
        documentationCollections: [domainConcepts, publicPackages],
      },
      answers: {},
      maxPages: 20,
    })).rejects.not.toBeInstanceOf(StructureInfeasibleConstraintsError);
    expect(provider.requests.length).toBeGreaterThan(0);
  });

  test("plans REST and SDK reference pages without a total page cap", async () => {
    const provider = new SequenceProvider([]);
    const restGroups = ["Accounts", "Projects", "Flags", "Environments"].map(
      (title) => {
        const id = title.toLowerCase();
        const sourcePath = `src/routes/${id}.ts`;
        return {
          id,
          title,
          sourceEvidence: [{ path: sourcePath }],
          endpoints: [{
            id: `get-${id}`,
            title: `GET /${id}`,
            method: "GET",
            path: `/${id}`,
            description: `List public ${id}.`,
            sourceEvidence: [{ path: sourcePath }],
          }],
        };
      },
    );
    const duplicateRestCollection: DocumentationCollection = {
      id: "rest-api-resource-groups",
      title: "REST API resource groups",
      kind: "docs",
      sourceEvidence: [],
      items: restGroups.map((group) => ({
        id: group.id,
        slug: group.id,
        title: group.title,
        sourceEvidence: group.sourceEvidence,
      })),
    };

    await expect(generateStructureWithRetry(provider, {
      analysis: {
        ...analysisFixture,
        documentationCollections: [duplicateRestCollection],
        referenceSurfaces: {
          rest: {
            label: "REST API",
            slug: "rest-api",
            sourceEvidence: [],
            groups: restGroups,
          },
          sdk: {
            label: "API Reference",
            slug: "api-reference",
            sourceEvidence: [],
            modules: ["client", "react"].map((id) => ({
              id,
              title: id === "client" ? "Client" : "React",
              sourceEvidence: [{ path: `packages/${id}/src/index.ts` }],
              exports: [{
                id: `create-${id}`,
                name: `create${id[0]!.toUpperCase()}${id.slice(1)}`,
                kind: "function" as const,
                description: `Create the public ${id} API.`,
                sourceEvidence: [{ path: `packages/${id}/src/index.ts` }],
              }],
            })),
          },
        },
      },
      answers: {},
      maxPages: 2,
    })).rejects.not.toBeInstanceOf(StructureInfeasibleConstraintsError);
    expect(provider.requests.length).toBeGreaterThan(0);
  });

  test("reviews a structure when its mandatory collection floor fits the ceiling", async () => {
    const collection = collectionFixture("Domain concepts", 4);
    const structure = fixtureWithCollection(collection);
    const decisions = [
        ...validDecisions,
        ...collection.items.map((item) => ({
          action: "keep" as const,
          pageId: `documentation/${collection.id}/${item.slug}`,
          reason: "Required collection coverage",
        })),
      ];
    const directlyReviewed = applyStructureReviewDecisions(structure, decisions);
    expect(validateReviewedStructure(
      directlyReviewed,
      36,
      { ...analysisFixture, documentationCollections: [collection] },
      structure,
    )).toEqual({ valid: true, errors: [] });
    const provider = new SequenceProvider([JSON.stringify({ decisions })]);

    const reviewed = await reviewStructureWithRetry(provider, {
      analysis: {
        ...analysisFixture,
        documentationCollections: [collection],
      },
      structure,
      maxPages: 36,
    });

    expect(provider.requests).toHaveLength(1);
    expect(reviewed.sections[0]?.pages.some(
      (page) => page.collectionId === collection.id,
    )).toBe(true);
  });

  test("marks inventory-backed collection and reference pages mandatory in the review payload", () => {
    const collection = collectionFixture("Domain concepts", 4);
    const structure = fixtureWithCollection(collection);
    structure.sections.push(
      {
        id: "rest-api",
        title: "REST API",
        pages: [{
          id: "widgets",
          title: "Widgets",
          description: "Use the public widget endpoints to read and manage application data.",
          reference: { kind: "rest", groupId: "widgets" },
        }],
      },
      {
        id: "api-reference",
        title: "API Reference",
        pages: [{
          id: "client",
          title: "Client",
          description: "Use the public SDK client module from a TypeScript application.",
          reference: { kind: "sdk", moduleId: "client" },
        }],
      },
    );
    const prompt = prompts.buildStructureReviewPrompt({
      analysis: {
        ...analysisFixture,
        documentationCollections: [collection],
        referenceSurfaces: {
          rest: {
            label: "REST API",
            slug: "rest-api",
            sourceEvidence: [],
            groups: [{
              id: "widgets",
              title: "Widgets",
              sourceEvidence: [],
              endpoints: [],
            }],
          },
          sdk: {
            label: "API Reference",
            slug: "api-reference",
            sourceEvidence: [],
            modules: [{
              id: "client",
              title: "Client",
              sourceEvidence: [],
              exports: [],
            }],
          },
        },
      },
      structure,
      maxPages: 36,
    });
    const pages = JSON.parse(
      prompt.user.match(/PAGES:\n([\s\S]+?)\n\nChoose exactly one action/)?.[1] ?? "[]",
    ) as Array<Record<string, unknown>>;

    expect(pages.find((page) => page.pageId === "documentation/domain-concepts/item-1")).toMatchObject({
      collectionId: "domain-concepts",
      mandatory: true,
    });
    expect(pages.find((page) => page.pageId === "rest-api/widgets")).toMatchObject({
      reference: { kind: "rest", groupId: "widgets" },
      mandatory: true,
    });
    expect(pages.find((page) => page.pageId === "api-reference/client")).toMatchObject({
      reference: { kind: "sdk", moduleId: "client" },
      mandatory: true,
    });
    expect(prompt.user).toContain('Pages marked "mandatory" are derived from the project\'s own inventory.');
  });

  test("retries dropped mandatory pages with actionable review coverage feedback", async () => {
    const collection = collectionFixture("Domain concepts", 4);
    const structure = fixtureWithCollection(collection);
    const provider = new SequenceProvider([
      JSON.stringify({
        decisions: [
          ...validDecisions,
          ...collection.items.map((item) => ({
            action: "drop",
            pageId: `documentation/${collection.id}/${item.slug}`,
            reason: "Reduce the number of pages",
          })),
        ],
      }),
      JSON.stringify({
        decisions: [
          ...validDecisions,
          ...collection.items.map((item) => ({
            action: "keep",
            pageId: `documentation/${collection.id}/${item.slug}`,
            reason: "Required collection coverage",
          })),
        ],
      }),
    ]);

    await reviewStructureWithRetry(provider, {
      analysis: {
        ...analysisFixture,
        documentationCollections: [collection],
      },
      structure,
      maxPages: 36,
    });

    const retryPrompt = provider.requests[1]?.messages.find(
      (message) => message.role === "user",
    )?.content;
    expect(retryPrompt).toContain(
      'Issue "keep" for pageId documentation/domain-concepts/item-1 instead of dropping it.',
    );
    expect(retryPrompt).not.toContain("Create a parent page with child pages for each item.");
  });

  test("retries moved REST and SDK reference pages with actionable move feedback", async () => {
    const structure: DocumentationStructure = {
      sections: [
        {
          id: "documentation",
          title: "Documentation",
          default: true,
          pages: [{
            id: "overview",
            title: "Overview",
            description: "Understand the product and its primary public user workflow.",
          }],
        },
        {
          id: "rest-api",
          title: "REST API",
          pages: [{
            id: "widgets",
            title: "Widgets",
            description: "Use public widget endpoints to read and manage application data.",
            reference: { kind: "rest", groupId: "widgets" },
          }, {
              id: "get-widgets",
              title: "Get widgets",
              description: "Fetch the widgets available to the current application account.",
              reference: {
                kind: "rest",
                groupId: "widgets",
                endpointId: "get-widgets",
              },
          }],
        },
        {
          id: "api-reference",
          title: "API Reference",
          pages: [{
            id: "client",
            title: "Client",
            description: "Use the public SDK client from a TypeScript application.",
            reference: { kind: "sdk", moduleId: "client" },
          }, {
              id: "create-client",
              title: "Create client",
              description: "Create the public SDK client for an application integration.",
              reference: { kind: "sdk", exportId: "create-client" },
          }],
        },
      ],
    };
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      referenceSurfaces: {
        rest: {
          label: "REST API",
          slug: "rest-api",
          sourceEvidence: [],
          groups: [{
            id: "widgets",
            title: "Widgets",
            sourceEvidence: [],
            endpoints: [{
              id: "get-widgets",
              title: "Get widgets",
              method: "GET",
              path: "/widgets",
              description: "Fetch the widgets available to the current application account.",
              sourceEvidence: [],
            }],
          }],
        },
        sdk: {
          label: "API Reference",
          slug: "api-reference",
          sourceEvidence: [],
          modules: [{
            id: "client",
            title: "Client",
            sourceEvidence: [],
            exports: [{
              id: "create-client",
              name: "createClient",
              kind: "function",
              description: "Create the public SDK client for an application integration.",
              sourceEvidence: [],
            }],
          }],
        },
      },
    };
    const provider = new SequenceProvider([
      JSON.stringify({
        decisions: [
          { action: "keep", pageId: "documentation/overview", reason: "Public entry point" },
          { action: "move", pageId: "rest-api/widgets", targetSectionId: "documentation", reason: "Keep reference near setup" },
          { action: "move", pageId: "api-reference/client", targetSectionId: "documentation", reason: "Keep SDK near setup" },
          { action: "move", pageId: "api-reference/create-client", targetSectionId: "documentation", reason: "Keep SDK near setup" },
        ],
      }),
      JSON.stringify({
        decisions: [
          { action: "keep", pageId: "documentation/overview", reason: "Public entry point" },
          { action: "keep", pageId: "rest-api/widgets", reason: "Required REST reference" },
          { action: "keep", pageId: "api-reference/client", reason: "Required SDK reference" },
          { action: "keep", pageId: "api-reference/create-client", reason: "Required SDK reference" },
        ],
      }),
    ]);

    await reviewStructureWithRetry(provider, { analysis, structure, maxPages: 10 });

    expect(provider.requests).toHaveLength(2);
    const retryPrompt = provider.requests[1]?.messages.find(
      (message) => message.role === "user",
    )?.content;
    expect(retryPrompt).toContain(
      'Issue "move" for pageId rest-api/widgets with targetSectionId rest-api.',
    );
    expect(retryPrompt).toContain(
      'Issue "move" for pageId api-reference/client with targetSectionId api-reference.',
    );
    expect(retryPrompt).not.toContain('Detected public REST API endpoints but no separate "REST API" section exists.');
    expect(retryPrompt).not.toContain('Detected public SDK exports but no separate "API Reference" section exists.');
  });

  test("keeps template endpoint pages without a decision and refuses to change them", () => {
    const structure: DocumentationStructure = {
      sections: [
        {
          id: "documentation",
          title: "Documentation",
          default: true,
          pages: [{
            id: "overview",
            title: "Overview",
            description: "Understand the product and its primary public user workflow.",
          }],
        },
        {
          id: "rest-api",
          title: "REST API",
          pages: [{
            id: "get-widgets",
            title: "Get widgets",
            description: "Fetch the widgets available to the current application account.",
            reference: { kind: "rest", groupId: "widgets", endpointId: "get-widgets" },
          }],
        },
      ],
    };
    const keepOverview = { action: "keep" as const, pageId: "documentation/overview", reason: "Entry point" };

    expect(applyStructureReviewDecisions(structure, [keepOverview])).toEqual(structure);
    expect(() => applyStructureReviewDecisions(structure, [
      keepOverview,
      { action: "drop", pageId: "rest-api/get-widgets", reason: "Too detailed" },
    ])).toThrow("Structure review cannot drop the fixed reference page rest-api/get-widgets.");
    expect(() => applyStructureReviewDecisions(structure, [
      { action: "merge", pageId: "documentation/overview", targetPageId: "rest-api/get-widgets", reason: "Same goal" },
    ])).toThrow("Merge target rest-api/get-widgets is a fixed reference page.");
  });

  test("summarizes template endpoint pages in the review prompt instead of listing them", () => {
    const endpoints = Array.from({ length: 40 }, (_, index) => ({
      id: `endpoint-${index}`,
      title: `Endpoint ${index}`,
      description: `Call public endpoint ${index}.`,
      group: "Widgets",
      reference: { kind: "rest" as const, groupId: "widgets", endpointId: `endpoint-${index}` },
    }));
    const prompt = prompts.buildStructureReviewPrompt({
      analysis: analysisFixture,
      structure: {
        sections: [
          {
            id: "documentation",
            title: "Documentation",
            default: true,
            pages: [{ id: "overview", title: "Overview", description: "Start here." }],
          },
          { id: "rest-api", title: "REST API", pages: endpoints },
        ],
      },
      maxPages: 10,
    });

    expect(prompt.user).toContain("- rest-api / Widgets: 40 endpoint pages, fixed by the API surface");
    expect(prompt.user).not.toContain("rest-api/endpoint-0");
    expect(prompt.user).toContain('"pageId": "documentation/overview"');
  });

  test("keeps generation-mode collection coverage feedback byte-identical", () => {
    const collection = collectionFixture("Domain concepts", 4);
    const validation = validateDocumentationStructureForProfile({
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [{
          id: "overview",
          title: "Overview",
          description: "Understand the product and its primary public user workflow.",
        }],
      }],
    }, {
      ...analysisFixture,
      documentationCollections: [collection],
    });

    expect(validation.errors).toContain(
      'Detected 4-item collection "Domain concepts" but no grouped pages represent its items.',
    );
  });

  test("rejects multiple default sections before calling the model", async () => {
    const provider = new SequenceProvider([]);
    const structure = reviewFixture();
    if (structure.sections[1]) structure.sections[1].default = true;

    await expect(reviewStructureWithRetry(provider, {
      analysis: analysisFixture,
      structure,
      maxPages: 20,
    })).rejects.toBeInstanceOf(StructureInfeasibleConstraintsError);
    expect(provider.requests).toHaveLength(0);
  });

  test("keeps the published-page bias on every review attempt", async () => {
    const provider = new SequenceProvider([
      JSON.stringify({
        decisions: [
          {
            action: "keep",
            pageId: "documentation/overview",
            reason: "Incomplete response",
          },
        ],
      }),
      JSON.stringify({ decisions: validDecisions }),
    ]);

    await reviewStructureWithRetry(provider, {
      analysis: analysisFixture,
      structure: reviewFixture(),
      publishedStructure: reviewFixture(),
      changedSourcePaths: ["src/public-api.ts"],
      maxPages: 2,
    });

    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) {
      const userMessage = request.messages.find(
        (message) => message.role === "user",
      );
      expect(userMessage?.content).toContain("must be keep");
      expect(userMessage?.content).toContain("src/public-api.ts");
    }
  });

  test("rejects a reviewed structure that removes required collection coverage", () => {
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      documentationCollections: [
        {
          id: "concepts",
          title: "Domain concepts",
          kind: "docs",
          sourceEvidence: [{ path: "docs/concepts" }],
          items: ["accounts", "projects", "environments", "deployments"].map((id) => ({
            id,
            slug: id,
            title: id[0]!.toUpperCase() + id.slice(1),
            sourceEvidence: [{ path: `docs/concepts/${id}.md` }],
          })),
        },
      ],
    };
    const reviewed: DocumentationStructure = {
      sections: [
        {
          id: "documentation",
          title: "Documentation",
          default: true,
          pages: [
            {
              id: "overview",
              title: "Overview",
              description: "Understand the product and its primary public workflows.",
            },
          ],
        },
      ],
    };

    expect(validateReviewedStructure(reviewed, 10, analysis)).toEqual({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/Domain concepts.*no grouped pages/i),
      ]),
    });
  });

  test("allows the same local page ID in different sections", () => {
    const reviewed: DocumentationStructure = {
      sections: [
        {
          id: "documentation",
          title: "Documentation",
          default: true,
          pages: [
            {
              id: "core-engine",
              title: "Core Engine",
              description:
                "Understand the public engine concepts and the workflows built on top of them.",
            },
          ],
        },
        {
          id: "api-reference",
          title: "API Reference",
          pages: [
            {
              id: "core-engine",
              title: "Core Engine API",
              description:
                "Use the exported engine interface from an application integration.",
            },
          ],
        },
      ],
    };

    expect(validateReviewedStructure(reviewed, 10)).toEqual({
      valid: true,
      errors: [],
    });
  });
});
