import { describe, expect, test } from "vitest";
import { z } from "zod/v4";
import {
  addUsage,
  buildDeterministicNavOrderManifest,
  buildRouteRegistry,
  defineTool,
  emptyUsage,
  ensureReferenceSections,
  flattenStructure,
  recordUsage,
  rewriteInternalLinks,
  run,
  captureUsage,
  sectionConfigForStructure,
  StructureGenerationFailedError,
  StructurePipelineDefectError,
  subscribeUsage,
  validateGlobalPageIds,
  validateDocumentationStructureForProfile,
} from "../src";
import { generateStructureWithRetry } from "../src/doxa-agent/structure-runner";
import type {
  ChatRequest,
  ChatResponse,
  DocumentationStructure,
  ProjectAnalysis,
  Provider,
  RestApiReferenceEndpoint,
  RestApiReferenceGroup,
  SdkApiReferenceModule,
  StructureSuggestionInput,
  UsageRecord,
} from "../src";
import { resolveDocumentationBrief } from "../src";
import { analysisFixture } from "./fixtures";

const baseStructure: DocumentationStructure = {
  sections: [
    {
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        {
          id: "providers",
          title: "Authentication Providers",
          description: "Configure sign-in providers.",
          sourceEvidence: [{ path: "docs/pages/getting-started/providers/index.mdx", kind: "docs" }],
        },
        {
          id: "providers/passkey",
          title: "Passkey Provider",
          description: "Configure passkey sign-in.",
          group: "Authentication Providers",
          sourceEvidence: [{ path: "docs/pages/getting-started/providers/passkey.mdx", kind: "docs" }],
        },
      ],
    },
  ],
};

const referenceAnalysis: ProjectAnalysis = {
  ...analysisFixture,
  projectType: "SDK and API",
  projectCategory: "api",
  hasApiRoutes: true,
  referenceSurfaces: {
    rest: {
      label: "REST API",
      slug: "rest-api",
      sourceEvidence: [],
      groups: [
        {
          id: "messages",
          title: "Messages",
          sourceEvidence: [],
          endpoints: [
            {
              id: "create-message",
              title: "Create message",
              method: "POST",
              path: "/v1/messages",
              description: "Create a message.",
              sourceEvidence: [{ path: "src/routes/messages.ts" }],
            },
          ],
        },
      ],
    },
    sdk: {
      label: "API Reference",
      slug: "api-reference",
      sourceEvidence: [],
      modules: [
        {
          id: "client",
          title: "Client",
          packageName: "@example/sdk",
          sourceEvidence: [],
          exports: [
            {
              id: "create-client",
              name: "createClient",
              kind: "function",
              description: "Create an SDK client.",
              sourceEvidence: [{ path: "src/client.ts" }],
            },
          ],
        },
      ],
    },
  },
};

function webhooksReferenceAnalysis(): ProjectAnalysis {
  return {
    ...referenceAnalysis,
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        sourceEvidence: [{ path: "src/routes/webhooks.ts" }],
        groups: [{
          id: "webhooks",
          title: "Webhooks",
          sourceEvidence: [{ path: "src/routes/webhooks.ts" }],
          endpoints: [{
            id: "deliver-webhook",
            title: "Deliver webhook",
            method: "POST",
            path: "/webhooks",
            description: "Deliver a webhook notification to a configured destination.",
            sourceEvidence: [{ path: "src/routes/webhooks.ts" }],
          }],
        }],
      },
    },
  };
}

function restEndpointPages(structure: DocumentationStructure) {
  return structure.sections
    .find((section) => section.id === "rest-api")
    ?.pages.filter((page) => page.reference?.pageKind === "endpoint") ?? [];
}

function restEndpoint(
  id: string,
  title: string,
  path: string,
): RestApiReferenceEndpoint {
  return {
    id,
    title,
    method: "GET",
    path,
    description: `Return the public ${title.toLowerCase()} resource for the current API consumer.`,
    sourceEvidence: [{ path: `src/routes/${id}.ts` }],
  };
}

function restGroup(
  id: string,
  title: string,
  endpoints: RestApiReferenceEndpoint[],
): RestApiReferenceGroup {
  return {
    id,
    title,
    description: `Use the public ${title.toLowerCase()} REST API resources and supported operations.`,
    sourceEvidence: endpoints.flatMap((endpoint) => endpoint.sourceEvidence),
    endpoints,
  };
}

function sdkModule(id: string, title: string): SdkApiReferenceModule {
  return {
    id,
    title,
    packageName: "@example/sdk",
    description: `Use the public ${title.toLowerCase()} SDK module and its supported exports.`,
    sourceEvidence: [{ path: `src/${id}.ts` }],
    exports: [{
      id: `create-${id}`,
      name: `create${title}`,
      kind: "function",
      description: `Create a public ${title.toLowerCase()} SDK resource.`,
      sourceEvidence: [{ path: `src/${id}.ts` }],
    }],
  };
}

function structureWithWebhookCollisions(): DocumentationStructure {
  return {
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [{
        id: "webhooks",
        title: "Webhooks",
        description: "Configure outgoing webhook delivery for events in your project.",
      }, {
          id: "post-webhooks",
          title: "POST /webhooks",
          description: "Configure the application webhook delivery endpoint.",
          group: "Webhooks",
      }],
    }],
  };
}

function structureProvider(userPrompts: string[], responses: unknown[]): Provider {
  let index = 0;
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model: "test-model",
    },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      userPrompts.push(request.messages.find((message) => message.role === "user")?.content ?? "");
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(response),
        },
        finishReason: "stop",
      };
    },
    chatStream: async function* () {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: "Unused stream response.",
        },
        finishReason: "stop",
      };
    },
  };
}

function structureWithPages(pages: Array<{ id: string; title: string; description: string }>): unknown {
  return {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages,
      },
    ],
  };
}

describe("legacy route and structure utilities", () => {
  test("builds route aliases and rewrites legacy internal links", () => {
    const registry = buildRouteRegistry(baseStructure);
    const content = [
      "See [source route](/getting-started/providers/passkey#setup).",
      "Already valid: [Passkey](/providers/passkey).",
      '<a href="/authentication-providers/passkey-provider?tab=setup">legacy</a>',
    ].join("\n");

    expect(registry.entries.map((entry) => entry.route)).toEqual([
      "/providers",
      "/providers/passkey",
    ]);
    expect(registry.aliasToRoute.get("/authentication-providers")).toBe("/providers");
    expect(rewriteInternalLinks(content, registry)).toContain("/providers/passkey#setup");
    expect(rewriteInternalLinks(content, registry)).toContain('href="/providers/passkey?tab=setup"');
  });

  test("flattens default and non-default sections into stable markdown paths", () => {
    const paths = flattenStructure({
      sections: [
        baseStructure.sections[0],
        {
          id: "guides",
          title: "How-To Guides",
          pages: [{ id: "deploy", title: "Deploy", description: "Deploy guide." }],
        },
      ],
    }).map((target) => target.path);

    expect(paths).toEqual([
      "default/providers.md",
      "default/providers/passkey.md",
      "guides/deploy.md",
    ]);
  });
});

describe("legacy reference surfaces", () => {
  test("keeps natural reference IDs across sections while globally de-conflicting titles", () => {
    const analysis = webhooksReferenceAnalysis();
    const structure = ensureReferenceSections(structureWithWebhookCollisions(), analysis);
    const referencePage = restEndpointPages(structure)[0];

    expect(validateGlobalPageIds(structure)).toEqual([]);
    expect(
      flattenStructure(structure).find((target) =>
        target.sectionId === "rest-api" &&
        target.page.id === "post-webhooks"
      )?.path,
    ).toBe("rest-api/post-webhooks.md");
    expect(referencePage).toMatchObject({
      id: "post-webhooks",
      title: "Deliver webhook",
      reference: {
        kind: "rest",
        groupId: "webhooks",
        endpointId: "deliver-webhook",
        method: "POST",
        path: "/webhooks",
      },
    });

    const validation = validateDocumentationStructureForProfile(structure, analysis);
    expect(validation.errors).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^Duplicate page title:/),
      expect.stringMatching(/missing.*(?:endpoint|export).*reference page/i),
    ]));
  });

  test("keeps non-colliding injected REST endpoint identities stable", () => {
    const structure = ensureReferenceSections(baseStructure, webhooksReferenceAnalysis());
    const referencePage = restEndpointPages(structure)[0];

    expect(referencePage).toMatchObject({
      id: "post-webhooks",
      title: "Deliver webhook",
      description: "Deliver a webhook notification to a configured destination.",
      sourceEvidence: [expect.objectContaining({ path: "src/routes/webhooks.ts" })],
      audience: "reference",
      reference: {
        kind: "rest",
        groupId: "webhooks",
        endpointId: "deliver-webhook",
        method: "POST",
        path: "/webhooks",
      },
    });
  });

  test("uses endpoint-derived IDs when resource group IDs repeat", () => {
    const firstEndpoint = restEndpoint("list-primary-flags", "primary flags", "/primary-flags");
    const secondEndpoint = restEndpoint("list-secondary-flags", "secondary flags", "/secondary-flags");
    const thirdEndpoint = restEndpoint("list-tertiary-flags", "tertiary flags", "/tertiary-flags");
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      referenceSurfaces: {
        rest: {
          label: "REST API",
          slug: "rest-api",
          sourceEvidence: [],
          groups: [
            restGroup("flags", "Primary flags", [firstEndpoint]),
            restGroup("flags", "Secondary flags", [secondEndpoint]),
            restGroup("flags", "Tertiary flags", [thirdEndpoint]),
          ],
        },
      },
    };

    const result = ensureReferenceSections(baseStructure, analysis);
    const referencePages = restEndpointPages(result);

    expect(referencePages?.map((page) => page.id)).toEqual([
      "get-primary-flags",
      "get-secondary-flags",
      "get-tertiary-flags",
    ]);
    expect(validateGlobalPageIds(result)).toEqual([]);
  });

  test("keeps REST and SDK IDs natural while de-conflicting their global titles", () => {
    const endpoint = restEndpoint("list-flags", "flags", "/flags");
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      referenceSurfaces: {
        rest: {
          label: "REST API",
          slug: "rest-api",
          sourceEvidence: [],
          groups: [restGroup("flags", "Flags", [endpoint])],
        },
        sdk: {
          label: "API Reference",
          slug: "api-reference",
          sourceEvidence: [],
          modules: [sdkModule("flags", "Flags")],
        },
      },
    };

    const result = ensureReferenceSections(baseStructure, analysis);
    const referencePages = [
      ...restEndpointPages(result),
      ...result.sections
        .find((section) => section.id === "api-reference")
        ?.pages.filter((page) => page.reference?.kind === "sdk") ?? [],
    ];

    expect(referencePages.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "get-flags", title: "List flags" },
      { id: "flags", title: "Flags" },
    ]);
    expect(validateGlobalPageIds(result)).toEqual([]);
    expect(validateDocumentationStructureForProfile(result, analysis).errors).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^Duplicate page title:/)]),
    );
  });

  test("rejects endpoint collisions that resource parents previously scoped apart", () => {
    const sharedEndpointId = "get-settings";
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      referenceSurfaces: {
        rest: {
          label: "REST API",
          slug: "rest-api",
          sourceEvidence: [],
          groups: [
            restGroup("project-settings", "Project settings", [
              restEndpoint(sharedEndpointId, "project settings", "/settings"),
            ]),
            restGroup("user-settings", "User settings", [
              restEndpoint(sharedEndpointId, "user settings", "/settings"),
            ]),
          ],
        },
      },
    };

    expect(() => ensureReferenceSections(baseStructure, analysis)).toThrow(
      /REST endpoint listed twice in section "rest-api".*get-settings/is,
    );
  });

  test("produces identical renamed reference pages on repeated runs", () => {
    const analysis = webhooksReferenceAnalysis();
    const first = ensureReferenceSections(structureWithWebhookCollisions(), analysis);
    const second = ensureReferenceSections(structureWithWebhookCollisions(), analysis);

    expect(second).toEqual(first);
  });

  test("creates one stable top-level REST page per HTTP method and path", () => {
    const analysis: ProjectAnalysis = {
      ...referenceAnalysis,
      referenceSurfaces: {
        ...referenceAnalysis.referenceSurfaces,
        rest: {
          ...referenceAnalysis.referenceSurfaces!.rest!,
          groups: [{
            ...referenceAnalysis.referenceSurfaces!.rest!.groups[0]!,
            endpoints: [
              {
                id: "get-auth-analysis-key",
                title: "Get authentication state",
                method: "GET",
                path: "/user/auth",
                description: "Return the current authentication state.",
                sourceEvidence: [{ path: "src/routes/auth.ts" }],
              },
              {
                id: "post-auth-analysis-key",
                title: "Create authentication state",
                method: "POST",
                path: "/user/auth",
                description: "Create a new authentication state.",
                sourceEvidence: [{ path: "src/routes/auth.ts" }],
              },
              {
                id: "get-environment-analysis-key",
                title: "Get environment",
                method: "GET",
                path: "/projects/:projectId/environments/:environmentKey",
                description: "Return one environment for a project.",
                sourceEvidence: [{ path: "src/routes/environments.ts" }],
              },
            ],
          }],
        },
      },
    };

    const first = ensureReferenceSections(baseStructure, analysis);
    const second = ensureReferenceSections(baseStructure, analysis);
    const endpointPages = restEndpointPages(first);

    expect(endpointPages).toEqual([
      expect.objectContaining({
        id: "get-user-auth",
        title: "Get authentication state",
        reference: expect.objectContaining({
          kind: "rest",
          pageKind: "endpoint",
          groupId: "messages",
          endpointId: "get-auth-analysis-key",
          method: "GET",
          path: "/user/auth",
        }),
      }),
      expect.objectContaining({
        id: "post-user-auth",
        title: "Create authentication state",
        reference: expect.objectContaining({
          kind: "rest",
          pageKind: "endpoint",
          groupId: "messages",
          endpointId: "post-auth-analysis-key",
          method: "POST",
          path: "/user/auth",
        }),
      }),
      expect.objectContaining({
        id: "get-projects-environments-environment-key",
        title: "Get environment",
        reference: expect.objectContaining({
          kind: "rest",
          pageKind: "endpoint",
          groupId: "messages",
          endpointId: "get-environment-analysis-key",
          method: "GET",
          path: "/projects/{projectId}/environments/{environmentKey}",
        }),
      }),
    ]);
    expect(restEndpointPages(second).map((page) => page.id))
      .toEqual(endpointPages?.map((page) => page.id));
    expect(validateGlobalPageIds(first)).toEqual([]);
  });

  test("rejects REST endpoint page-ID normalization collisions within a resource group", () => {
    const analysis: ProjectAnalysis = {
      ...referenceAnalysis,
      referenceSurfaces: {
        ...referenceAnalysis.referenceSurfaces,
        rest: {
          ...referenceAnalysis.referenceSurfaces!.rest!,
          groups: [{
            ...referenceAnalysis.referenceSurfaces!.rest!.groups[0]!,
            endpoints: [
              {
                id: "colon-param",
                title: "Get user by colon parameter",
                method: "GET",
                path: "/users/:id",
                description: "Return a user by identifier.",
                sourceEvidence: [],
              },
              {
                id: "braced-param",
                title: "Get user by braced parameter",
                method: "GET",
                path: "/users/{id}",
                description: "Return a user by identifier.",
                sourceEvidence: [],
              },
            ],
          }],
        },
      },
    };

    expect(() => ensureReferenceSections(baseStructure, analysis)).toThrow(
      /REST endpoint listed twice.*get-users-id/i,
    );
  });

  test("keeps terminal resource identifiers distinct from same-method collection pages", () => {
    const analysis: ProjectAnalysis = {
      ...referenceAnalysis,
      referenceSurfaces: {
        ...referenceAnalysis.referenceSurfaces,
        rest: {
          ...referenceAnalysis.referenceSurfaces!.rest!,
          groups: [{
            ...referenceAnalysis.referenceSurfaces!.rest!.groups[0]!,
            endpoints: [
              {
                id: "list-users-analysis-key",
                title: "List users",
                method: "GET",
                path: "/users",
                description: "List users.",
                sourceEvidence: [],
              },
              {
                id: "get-user-analysis-key",
                title: "Get user",
                method: "GET",
                path: "/users/:userId",
                description: "Get one user.",
                sourceEvidence: [],
              },
            ],
          }],
        },
      },
    };

    const structure = ensureReferenceSections(baseStructure, analysis);

    expect(restEndpointPages(structure).map((page) => page.id)).toEqual([
      "get-users",
      "get-users-user-id",
    ]);
    expect(validateGlobalPageIds(structure)).toEqual([]);
  });

  test("creates separate REST and SDK reference sections with reference layouts", async () => {
    const structure = ensureReferenceSections(baseStructure, referenceAnalysis);
    const sections = sectionConfigForStructure(structure);

    expect(structure.sections.map((section) => section.title)).toEqual([
      "Documentation",
      "REST API",
      "API Reference",
    ]);
    expect(restEndpointPages(structure)[0]).toMatchObject({
      id: "post-v1-messages",
      title: "Create message",
      reference: {
        kind: "rest",
        groupId: "messages",
        endpointId: "create-message",
        method: "POST",
        path: "/v1/messages",
      },
    });
    expect(structure.sections[2]?.pages[0]?.reference).toMatchObject({
      kind: "sdk",
      moduleId: "client",
    });
    expect(structure.sections[2]?.pages[0]).not.toHaveProperty("subPages");
    expect(restEndpointPages(structure)[0]?.sourceEvidence).toContainEqual({
      path: "src/routes/messages.ts",
    });
    expect(structure.sections[2]?.pages[0]?.sourceEvidence).toContainEqual({
      path: "src/client.ts",
    });
    const validation = validateDocumentationStructureForProfile(
      structure,
      referenceAnalysis,
    );
    expect(
      validation.errors.filter((error) =>
        /missing.*(?:endpoint|export).*reference page/i.test(error)
      ),
    ).toEqual([]);
    expect(sections.filter((section) => section.kind === "reference")).toHaveLength(2);

    const nav = await buildDeterministicNavOrderManifest(structure);
    expect(nav.navBadges).toMatchObject({
      "rest-api/post-v1-messages.md": "POST",
    });
  });
});

describe("legacy structure retry behavior", () => {
  test("threads the public generation brief into structure prompts", async () => {
    const userPrompts: string[] = [];
    const input: StructureSuggestionInput = {
      analysis: {
        ...analysisFixture,
        publicEditorialBrief: {
          intendedReaders: ["SDK developers"],
          readerGoals: ["Integrate quickly"],
          focusAreas: ["Authentication"],
          deprioritizedAreas: [],
          preferredTerminology: [],
        },
      },
      answers: {},
      documentationBrief: resolveDocumentationBrief({
        target: { kind: "public" },
        projectContext: "RAW CONTEXT MUST NOT REACH STRUCTURE",
      }),
    };
    const valid = structureWithPages([
      {
        id: "overview",
        title: "Overview",
        description: "Project overview covering goals, audience, and high-level capabilities in clear terms.",
      },
    ]);

    await generateStructureWithRetry(structureProvider(userPrompts, [valid]), input);

    expect(userPrompts[0]).toContain("PUBLIC EDITORIAL BRIEF");
    expect(userPrompts[0]).toContain("SDK developers");
    expect(userPrompts[0]).not.toContain("RAW CONTEXT MUST NOT REACH STRUCTURE");
  });

  test("retries validation failures and includes prior errors in retry prompts", async () => {
    const userPrompts: string[] = [];
    const input: StructureSuggestionInput = {
      analysis: analysisFixture,
      answers: {},
    };
    const invalid = structureWithPages([
      { id: "architecture", title: "Architecture", description: "Architecture." },
    ]);
    const valid = structureWithPages([
      {
        id: "overview",
        title: "Overview",
        description: "Project overview covering goals, audience, and high-level capabilities in clear terms.",
      },
    ]);

    const result = await generateStructureWithRetry(
      structureProvider(userPrompts, [invalid, valid]),
      input,
    );

    expect(result.sections[0]?.pages.map((page) => page.title)).toEqual(["Overview"]);
    expect(userPrompts).toHaveLength(2);
    expect(userPrompts[1]).toContain("Previous structure was rejected");
    expect(userPrompts[1]).toContain('Page "Architecture" has a weak or missing description');
  });

  test("fails once when duplicate collection identities make coverage inconsistent", async () => {
    const userPrompts: string[] = [];
    const input: StructureSuggestionInput = {
      analysis: {
        ...analysisFixture,
        documentationCollections: ["One", "Two"].map((suffix) => ({
          id: "shared",
          title: `Injected collection ${suffix}`,
          kind: "docs" as const,
          sourceEvidence: [],
          items: Array.from({ length: 4 }, (_, index) => ({
            id: `shared/${suffix.toLowerCase()}-${index + 1}`,
            slug: `${suffix.toLowerCase()}-${index + 1}`,
            title: `${suffix} item ${index + 1}`,
            sourceEvidence: [{ path: `docs/${suffix.toLowerCase()}-${index + 1}.md` }],
          })),
        })),
      },
      answers: {},
    };
    const cleanModelStructure = structureWithPages([{
      id: "overview",
      title: "Overview",
      description: "Understand the public project concepts and supported user workflows.",
    }]);

    await expect(
      generateStructureWithRetry(
        structureProvider(userPrompts, [cleanModelStructure]),
        input,
      ),
    ).rejects.toEqual(expect.objectContaining({
      name: "StructurePipelineDefectError",
      kind: "pipeline_defect",
      message: expect.stringContaining(
        'Collection "Injected collection One" is missing grouped pages',
      ),
    } satisfies Partial<StructurePipelineDefectError>));
    expect(userPrompts).toHaveLength(1);
  });

  test("repairs duplicate stable page IDs inside structure generation", async () => {
    const userPrompts: string[] = [];
    const input: StructureSuggestionInput = {
      analysis: analysisFixture,
      answers: {},
    };
    const duplicateIds = {
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
            {
              id: "core-engine",
              title: "Core Engine Internals",
              description:
                "Maintain the engine implementation and its repository development workflows.",
            },
          ],
        },
      ],
    };
    const valid = structureWithPages([
      {
        id: "overview",
        title: "Overview",
        description:
          "Project overview covering goals, audience, and high-level capabilities in clear terms.",
      },
    ]);

    const result = await generateStructureWithRetry(
      structureProvider(userPrompts, [duplicateIds, valid]),
      input,
    );

    expect(result.sections[0]?.pages.map((page) => page.id)).toEqual([
      "overview",
    ]);
    expect(userPrompts).toHaveLength(2);
    expect(userPrompts[1]).toContain("Previous structure was rejected");
    expect(userPrompts[1]).toContain(
      'Duplicate stable page ID "documentation/core-engine"',
    );
  });

  test("throws retryable structure failure after all attempts are invalid", async () => {
    const userPrompts: string[] = [];
    const input: StructureSuggestionInput = {
      analysis: analysisFixture,
      answers: {},
    };

    await expect(
      generateStructureWithRetry(
        structureProvider(userPrompts, [
          structureWithPages([{ id: "overview", title: "Overview", description: "Too short." }]),
        ]),
        input,
      ),
    ).rejects.toBeInstanceOf(StructureGenerationFailedError);
    expect(userPrompts).toHaveLength(3);
  });
});

describe("legacy usage aggregation", () => {
  test("sums token and optional cost fields", () => {
    expect(addUsage(
      { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.25, promptCost: 0.1 },
      { promptTokens: 3, completionTokens: 7, totalTokens: 10, cost: 0.5, completionCost: 0.35 },
    )).toEqual({
      promptTokens: 13,
      completionTokens: 12,
      totalTokens: 25,
      cost: 0.75,
      promptCost: 0.1,
      completionCost: 0.35,
    });
    expect(addUsage(emptyUsage(), emptyUsage())).toEqual(emptyUsage());
  });

  test("captures usage while preserving active subscribers", async () => {
    const records: UsageRecord[] = [];
    const unsubscribe = subscribeUsage((record) => records.push(record));

    try {
      const captured = await captureUsage(async () => {
        recordUsage({ promptTokens: 1, completionTokens: 2, totalTokens: 3, cost: 0.001 }, {
          model: "test/model",
          generationId: "gen-1",
        });
        recordUsage({ promptTokens: 4, completionTokens: 5, totalTokens: 9 });
        return "done";
      });

      expect(captured.result).toBe("done");
      expect(captured.usage).toEqual({
        promptTokens: 5,
        completionTokens: 7,
        totalTokens: 12,
        cost: 0.001,
      });
      expect(records).toHaveLength(2);
      expect(records[0]?.model).toBe("test/model");
      expect(records[0]?.generationId).toBe("gen-1");
    } finally {
      unsubscribe();
    }
  });
});

describe("legacy agent loop policy", () => {
  test("ends with the text of a response cut off at the token limit, not its tool call", async () => {
    let toolExecutions = 0;
    const read = defineTool({
      name: "read",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async () => {
        toolExecutions += 1;
        return "file";
      },
    });
    const cutOff: ChatResponse = {
      message: {
        role: "assistant",
        content: "# Quickstart\n\nInstall the SDK and",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"pa' } }],
      },
      finishReason: "length",
    };
    const provider: Provider = {
      config: { baseUrl: "https://example.test", apiKey: "test", model: "test-model" },
      chat: async () => cutOff,
      chatStream: async function* () {
        yield { type: "done", message: cutOff.message, finishReason: "length" };
      },
    };

    const result = await run({ provider, systemPrompt: "Write the page.", tools: [read] }, "Write.");

    expect(result.text).toBe("# Quickstart\n\nInstall the SDK and");
    expect(result.finishReason).toBe("length");
    expect(toolExecutions).toBe(0);
  });

  test("reserves the final request for a complete tools-disabled response", async () => {
    const requests: ChatRequest[] = [];
    let requestCount = 0;
    let toolExecutions = 0;
    const finalPage = "---\ntitle: Overview\n---\n\n## Overview\n\nComplete page.";
    const provider: Provider = {
      config: {
        baseUrl: "https://example.test",
        apiKey: "test",
        model: "test-model",
      },
      chat: async (request) => {
        requests.push(request);
        requestCount += 1;

        if (requestCount < 12) {
          return {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [
                {
                  id: `call-${requestCount}`,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({
                      path: "src/index.ts",
                      line: requestCount,
                    }),
                  },
                },
              ],
            },
            finishReason: "tool_calls",
          };
        }

        return {
          message: { role: "assistant", content: finalPage },
          finishReason: "stop",
        };
      },
      chatStream: async function* () {
        yield {
          type: "done",
          message: { role: "assistant", content: finalPage },
          finishReason: "stop",
        };
      },
    };

    const result = await run(
      {
        provider,
        systemPrompt: "Write documentation.",
        tools: [
          defineTool({
            name: "read",
            description: "Read repository evidence",
            parameters: z.object({
              path: z.string(),
              line: z.number(),
            }),
            execute: async () => {
              toolExecutions += 1;
              return "repository evidence";
            },
          }),
        ],
        maxSteps: 12,
        loopPolicy: {
          finalizationPrompt: "Write the complete page now.",
        },
      },
      "Write the page.",
    );

    expect(requests).toHaveLength(12);
    expect(
      requests.slice(0, 11).every((request) => Boolean(request.tools?.length)),
    ).toBe(true);
    expect(requests[11]?.tools).toBeUndefined();
    expect(requests[11]?.messages.at(-1)).toEqual({
      role: "user",
      content: "Write the complete page now.",
    });
    expect(toolExecutions).toBe(11);
    expect(result.text).toBe(finalPage);
    expect(result.loop?.termination).toBe("forced_finalization");
  });

  test("skips the third consecutive identical tool call", async () => {
    const requests: ChatRequest[] = [];
    let requestCount = 0;
    let toolExecutions = 0;
    const provider: Provider = {
      config: {
        baseUrl: "https://example.test",
        apiKey: "test",
        model: "test-model",
      },
      chat: async (request) => {
        requests.push(request);
        requestCount += 1;

        if (requestCount <= 3) {
          return {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [
                {
                  id: `call-${requestCount}`,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"src/index.ts"}',
                  },
                },
              ],
            },
            finishReason: "tool_calls",
          };
        }

        return {
          message: {
            role: "assistant",
            content: "---\ntitle: Overview\n---\n\nComplete page.",
          },
          finishReason: "stop",
        };
      },
      chatStream: async function* () {
        yield {
          type: "done",
          message: { role: "assistant", content: "Unused." },
          finishReason: "stop",
        };
      },
    };

    const result = await run(
      {
        provider,
        systemPrompt: "Write documentation.",
        tools: [
          defineTool({
            name: "read",
            description: "Read repository evidence",
            parameters: z.object({ path: z.string() }),
            execute: async () => {
              toolExecutions += 1;
              return "repository evidence";
            },
          }),
        ],
        maxSteps: 12,
        loopPolicy: {
          finalizationPrompt: "Write the complete page now.",
        },
      },
      "Write the page.",
    );

    expect(toolExecutions).toBe(2);
    expect(requests.at(-1)?.messages).toContainEqual({
      role: "tool",
      toolCallId: "call-3",
      content: expect.stringContaining("Repeated identical tool call blocked"),
    });
    expect(result.loop?.repeatedToolCallsBlocked).toBe(1);
  });

  test("does not execute a tool call returned on the terminal request", async () => {
    let requestCount = 0;
    let toolExecutions = 0;
    const provider: Provider = {
      config: {
        baseUrl: "https://example.test",
        apiKey: "test",
        model: "test-model",
      },
      chat: async () => {
        requestCount += 1;
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: `call-${requestCount}`,
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({
                    path: `src/file-${requestCount}.ts`,
                  }),
                },
              },
            ],
          },
          finishReason: "tool_calls",
        };
      },
      chatStream: async function* () {
        yield {
          type: "done",
          message: { role: "assistant", content: "Unused." },
          finishReason: "stop",
        };
      },
    };

    const result = await run(
      {
        provider,
        systemPrompt: "Write documentation.",
        tools: [
          defineTool({
            name: "read",
            description: "Read repository evidence",
            parameters: z.object({ path: z.string() }),
            execute: async () => {
              toolExecutions += 1;
              return "repository evidence";
            },
          }),
        ],
        maxSteps: 2,
        loopPolicy: {
          finalizationPrompt: "Write the complete page now.",
        },
      },
      "Write the page.",
    );

    expect(requestCount).toBe(2);
    expect(toolExecutions).toBe(1);
    expect(result.text).toBe("");
    expect(result.loop?.termination).toBe("agent_loop_exhausted");
  });
});
