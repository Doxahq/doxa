import { describe, expect, test } from "vitest";
import {
  validateGeneratedDocs,
  type DocumentationStructure,
  type GeneratedPageContent,
  type ProjectAnalysis,
} from "../src";
import { analysisFixture } from "./fixtures";

const outputDir = "/tmp/doxa-quality-test";

function referenceAnalysis(): ProjectAnalysis {
  return {
    ...analysisFixture,
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        sourceEvidence: [{ path: "src/routes.ts" }],
        groups: [
          {
            id: "widgets",
            title: "Widgets",
            sourceEvidence: [{ path: "src/routes.ts" }],
            endpoints: [
              {
                id: "get-widget",
                title: "Get widget",
                method: "GET",
                path: "/widgets/:id",
                description: "Fetch one widget.",
                sourceEvidence: [{ path: "src/routes.ts" }],
              },
              {
                id: "list-widgets",
                title: "List widgets",
                method: "GET",
                path: "/widgets",
                description: "List widgets.",
                sourceEvidence: [{ path: "src/routes.ts" }],
              },
            ],
          },
        ],
      },
    },
  };
}

function referenceStructure(): DocumentationStructure {
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
            description: "Understand the public product and its primary user workflow.",
          },
        ],
      },
      {
        id: "rest-api",
        title: "REST API",
        pages: [
          {
                id: "get-widget",
                title: "Get widget",
                description: "Fetch a single widget by its stable identifier.",
                group: "Widgets",
                reference: {
                  kind: "rest",
                  groupId: "widgets",
                  endpointId: "get-widget",
                },
          },
          {
                id: "list-widgets",
                title: "List widgets",
                description: "List the widgets available to the current account.",
                group: "Widgets",
                reference: {
                  kind: "rest",
                  groupId: "widgets",
                  endpointId: "list-widgets",
                },
          },
        ],
      },
    ],
  };
}

function generatedPage(id: string, path: string, title: string): GeneratedPageContent {
  return {
    id,
    path: `${outputDir}/${path}`,
    title,
    content: `---\ntitle: ${title}\n---\n\n# ${title}\n\nComplete reference documentation for this endpoint.`,
    dependencies: {
      sourceFilesRead: [],
      sourceFilesDiscovered: [],
      sourceEvidenceFiles: [],
      referencedSymbols: [],
      referencedRoutes: [],
    },
    contentHash: "content",
    pageInputHash: "input",
  };
}

function pageWithContent(
  id: string,
  path: string,
  title: string,
  body: string,
): GeneratedPageContent {
  return {
    ...generatedPage(id, path, title),
    content: `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}`,
  };
}

function consumerStructure(): DocumentationStructure {
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
            description: "Learn how to use the product.",
          },
        ],
      },
      {
        id: "public-packages",
        title: "Public packages",
        pages: [
          {
            id: "concepts",
            title: "Package concepts",
            description: "Understand the public package model.",
          },
        ],
      },
      {
        id: "packages",
        title: "Packages",
        pages: [
          {
            id: "sdk",
            title: "SDK",
            description: "Use the public SDK.",
          },
        ],
      },
    ],
  };
}

function validateConsumerPage(page: GeneratedPageContent, structure = consumerStructure()) {
  return validateGeneratedDocs([page], {
    outputDir,
    structure,
    requireAllStructurePages: false,
    allowStructureRoutesForLinks: true,
  });
}

function quickstartStructure(): DocumentationStructure {
  return {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          {
            id: "quickstart",
            title: "Quickstart",
            description: "Install the SDK and complete the first verified request.",
          },
        ],
      },
    ],
  };
}

function validateQuickstart(body: string, analysis?: ProjectAnalysis) {
  return validateGeneratedDocs(
    [pageWithContent("quickstart", "quickstart.md", "Quickstart", body)],
    {
      outputDir,
      structure: quickstartStructure(),
      analysis,
      requireAllStructurePages: true,
    },
  );
}

function quickstartAnalysis(): ProjectAnalysis {
  return {
    ...analysisFixture,
    documentationIntent: {
      audience: "consumer",
      primaryUseCase: "Evaluate a feature flag from an application.",
      publicPackageNames: ["@flagforge/sdk"],
      canonicalWorkflows: [
        {
          name: "TypeScript SDK",
          framework: "TypeScript",
          installCommands: ["pnpm add @flagforge/sdk"],
          requiredFiles: ["src/index.ts"],
          canonicalImports: [
            'import { FlagForgeClient } from "@flagforge/sdk"',
          ],
          envVars: ["FLAGFORGE_API_KEY"],
          routePaths: ["/v1/flags/:key/evaluate"],
          verificationSteps: ["Confirm the response contains the evaluated flag value."],
          sourceEvidence: ["README.md"],
        },
      ],
      internalOnlyPaths: [],
      consumerTerminology: ["feature flag"],
    },
  };
}

describe("docs quality validation", () => {
  test("rejects renderer-owned sections on a finished REST endpoint page", () => {
    const report = validateGeneratedDocs(
      [pageWithContent(
        "get-widget",
        "rest-api/get-widget.md",
        "Get widget",
        [
          "## Response",
          "",
          "This duplicate response section repeats the deterministic response card.",
          "",
          "The endpoint behavior remains documented in a complete second paragraph.",
        ].join("\n"),
      )],
      {
        outputDir,
        structure: referenceStructure(),
        analysis: referenceAnalysis(),
        requireAllStructurePages: false,
      },
    );

    expect(report.issues).toContainEqual(expect.objectContaining({
      rule: "rest-endpoint-duplicate-section",
      severity: "error",
      route: "/rest-api/get-widget",
      line: 3,
      excerpt: "## Response",
    }));
    expect(report.ok).toBe(false);
  });

  test("allows the same heading on a non-endpoint page", () => {
    const report = validateGeneratedDocs(
      [pageWithContent(
        "widgets",
        "rest-api/widgets.md",
        "Widgets",
        "## Response\n\nThis resource overview explains the shared response model.",
      )],
      {
        outputDir,
        structure: referenceStructure(),
        requireAllStructurePages: false,
      },
    );

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "rest-endpoint-duplicate-section" }),
    ]));
  });

  test("accepts grouped endpoint pages without a group overview page", () => {
    const structure = referenceStructure();
    const groupPage = structure.sections[1]?.pages[0];
    if (!groupPage) {
      throw new Error("Reference fixture is missing its group page.");
    }

    const report = validateGeneratedDocs(
      [
        generatedPage("overview", "overview.md", "Overview"),
        generatedPage("get-widget", "rest-api/get-widget.md", "Get widget"),
        generatedPage("list-widgets", "rest-api/list-widgets.md", "List widgets"),
      ],
      {
        outputDir,
        structure,
        analysis: referenceAnalysis(),
        requireAllStructurePages: false,
      },
    );

    expect(groupPage.group).toBe("Widgets");
    expect(groupPage.reference).toMatchObject({ kind: "rest", endpointId: "get-widget" });
    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: expect.stringMatching(/missing-rest-reference/),
      }),
    ]));
    expect(report.ok).toBe(true);
  });

  test("accepts top-level endpoint pages without a group overview page", () => {
    const structure = referenceStructure();

    const report = validateGeneratedDocs(
      [
        generatedPage("overview", "overview.md", "Overview"),
        generatedPage("get-widget", "rest-api/get-widget.md", "Get widget"),
        generatedPage("list-widgets", "rest-api/list-widgets.md", "List widgets"),
      ],
      {
        outputDir,
        structure,
        analysis: referenceAnalysis(),
        requireAllStructurePages: true,
      },
    );

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: expect.stringMatching(/missing-rest-reference/),
      }),
    ]));
    expect(report.ok).toBe(true);
  });

  test("does not let a repeated endpoint ID cover another resource group", () => {
    const analysis = referenceAnalysis();
    const widgets = analysis.referenceSurfaces?.rest?.groups[0];
    if (!widgets) throw new Error("Reference analysis fixture is missing widgets.");
    analysis.referenceSurfaces!.rest!.groups = [
      {
        ...widgets,
        id: "primary-widgets",
        endpoints: [{ ...widgets.endpoints[0]!, id: "shared-get" }],
      },
      {
        ...widgets,
        id: "secondary-widgets",
        title: "Secondary widgets",
        endpoints: [{
          ...widgets.endpoints[1]!,
          id: "shared-get",
          path: "/secondary-widgets",
        }],
      },
    ];
    const structure: DocumentationStructure = {
      sections: [
        referenceStructure().sections[0]!,
        {
          id: "rest-api",
          title: "REST API",
          pages: [{
            id: "get-widget",
            title: "GET /widgets/:id",
            description: "Fetch one widget through the public REST API.",
            reference: {
              kind: "rest",
              groupId: "primary-widgets",
              endpointId: "shared-get",
              method: "GET",
              path: "/widgets/:id",
            },
          }],
        },
      ],
    };

    const report = validateGeneratedDocs([], {
      outputDir,
      structure,
      analysis,
      requireAllStructurePages: false,
    });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "missing-rest-reference-page",
        message: expect.stringContaining("/secondary-widgets"),
      }),
    ]));
  });

  test("does not treat a generated resource page as coverage for its endpoint pages", () => {
    const structure = referenceStructure();
    const restSection = structure.sections[1];
    if (!restSection) {
      throw new Error("Reference fixture is missing its REST section.");
    }
    restSection.pages = [{
      id: "widgets",
      title: "Widgets",
      description: "Use the public widget endpoints to read application data.",
      reference: { kind: "rest", pageKind: "group", groupId: "widgets" },
    }];

    const report = validateGeneratedDocs(
      [
        generatedPage("overview", "overview.md", "Overview"),
        generatedPage("widgets", "rest-api/widgets.md", "Widgets"),
      ],
      {
        outputDir,
        structure,
        analysis: referenceAnalysis(),
        requireAllStructurePages: true,
      },
    );

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "missing-rest-reference-page",
      }),
    ]));
    expect(report.ok).toBe(false);
  });

  test("does not require routes outside the current partial generation batch", () => {
    const pages = [
      generatedPage("get-widget", "rest-api/get-widget.md", "Get widget"),
    ];
    const report = validateGeneratedDocs(
      pages,
      {
        outputDir,
        structure: referenceStructure(),
        analysis: referenceAnalysis(),
        requireAllStructurePages: false,
        allowStructureRoutesForLinks: true,
      },
    );

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "missing-rest-reference-route",
        route: "/rest-api/list-widgets",
      }),
    ]));
    expect(report.ok).toBe(true);

    const fullReport = validateGeneratedDocs(pages, {
      outputDir,
      structure: referenceStructure(),
      analysis: referenceAnalysis(),
      requireAllStructurePages: true,
    });
    expect(fullReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "missing-rest-reference-route",
        route: "/rest-api/list-widgets",
      }),
    ]));
    expect(fullReport.ok).toBe(false);
  });

  test.each([
    ["plain generated route", "Read /public-packages/concepts for the domain model."],
    ["Markdown link", "Read [package concepts](/public-packages/concepts)."],
    ["JSX href", '<Card title="Domain concepts" href="/public-packages/concepts">Learn more.</Card>'],
    ["single-quoted JSX href", "<Card href='/public-packages/concepts'>Learn more.</Card>"],
    ["JSX expression href", "<Card href={'/public-packages/concepts'}>Learn more.</Card>"],
    ["route with query and fragment", "[Concepts](/public-packages/concepts?tab=api#usage)"],
    ["route with packages as a complete segment", "See /packages/sdk for SDK usage."],
  ])("does not treat a valid %s as a repository path", (_name, body) => {
    const page = pageWithContent(
      "public-packages/concepts",
      "public-packages/concepts.md",
      "Package concepts",
      body,
    );
    const report = validateConsumerPage(page);

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-internal-path" }),
    ]));
  });

  test("reports an unknown packages route as an unresolved link, not leaked prose", () => {
    const page = pageWithContent(
      "overview",
      "overview.md",
      "Overview",
      "Read [the SDK guide](/packages/unknown) for details.",
    );
    const report = validateConsumerPage(page, {
      sections: consumerStructure().sections.slice(0, 1),
    });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "unresolved-internal-link",
        excerpt: "/packages/unknown",
      }),
    ]));
    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-internal-path" }),
    ]));
  });

  test("validates internal routes inside JSX expression hrefs", () => {
    const page = pageWithContent(
      "overview",
      "overview.md",
      "Overview",
      "<Card href={'/packages/unknown'}>Unknown package</Card>",
    );
    const report = validateConsumerPage(page, {
      sections: consumerStructure().sections.slice(0, 1),
    });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "unresolved-internal-link",
        excerpt: "/packages/unknown",
      }),
    ]));
    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-internal-path" }),
    ]));
  });

  test.each([
    ["package source file", "Edit packages/sdk/src/index.ts to change the client."],
    ["absolute package source file", "Edit /packages/sdk/src/index.ts to change the client."],
    ["fixture file", "Load fixtures/example.json before continuing."],
    ["test directory", "Copy __tests__/helpers.ts into the project."],
    ["GitHub workflow", "Run the steps from .github/workflows/ci.yml."],
    ["application workspace", "Start apps/dev before using this feature."],
    ["end-to-end test", "Review e2e/auth.spec.ts for the expected flow."],
    ["Playwright config", "Change playwright.config.ts to enable the feature."],
    ["inline-code path", "Import `packages/sdk/src/client.ts` directly."],
    ["parenthesized path", "Use (packages/sdk/src/client.ts) as the entry point."],
    ["quoted path", 'Import "fixtures/example.json" in the example.'],
  ])("detects repository-internal prose: %s", (_name, body) => {
    const report = validateConsumerPage(
      pageWithContent("overview", "overview.md", "Overview", body),
    );

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-internal-path" }),
    ]));
  });

  test.each([
    ["hyphenated public route", "Read /public-packages/concepts for details."],
    ["ordinary plural noun", "These packages provide the public SDK."],
    ["singular noun", "Install the package before continuing."],
    ["larger identifier", "The multipackages/sdk label is user-defined."],
    [
      "external Markdown destination",
      "Browse [the source](https://github.com/example/project/tree/main/packages/sdk).",
    ],
    [
      "external JSX destination",
      '<Card href="https://github.com/example/project/tree/main/fixtures/example.json">Source</Card>',
    ],
  ])("does not flag non-repository prose: %s", (_name, body) => {
    const report = validateConsumerPage(
      pageWithContent("overview", "overview.md", "Overview", body),
    );

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-internal-path" }),
    ]));
  });

  test.each([
    ["pnpm direct", "Run pnpm dev to start the contributor server."],
    ["pnpm run", "Run pnpm run typecheck before continuing."],
    ["Bun", "Run bun test against the repository."],
    ["npm run", "Run npm run lint before opening the page."],
    ["Yarn", "Run yarn format to rewrite contributor files."],
  ])("detects local contributor command: %s", (_name, body) => {
    const report = validateConsumerPage(
      pageWithContent("overview", "overview.md", "Overview", body),
    );

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-dev-script" }),
    ]));
  });

  test.each([
    ["package installation", "Run npm install @example/sdk to install the client."],
    ["pnpm package addition", "Run pnpm add @example/sdk to install the client."],
    ["product test noun", "Use the test environment described in this guide."],
  ])("allows consumer command or prose: %s", (_name, body) => {
    const report = validateConsumerPage(
      pageWithContent("overview", "overview.md", "Overview", body),
    );

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-dev-script" }),
    ]));
  });

  test.each([
    ["demo email", "Sign in with test@example.com."],
    ["demo password", "Use password123 for the demo account."],
    ["debug default", "Set debug: true in the configuration."],
    ["unstable API", "Call unstable_createClient() to initialize the SDK."],
  ])("detects unsafe consumer credential or API example: %s", (_name, body) => {
    const report = validateConsumerPage(
      pageWithContent("overview", "overview.md", "Overview", body),
    );

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-test-credential" }),
    ]));
  });

  test.each([
    ["real email", "Sign in with your own verified email address."],
    ["secure password guidance", "Use a unique password from your password manager."],
    ["disabled debug", "Keep debug: false in production."],
    ["stable API", "Call createClient() to initialize the SDK."],
  ])("allows safe consumer credential or API prose: %s", (_name, body) => {
    const report = validateConsumerPage(
      pageWithContent("overview", "overview.md", "Overview", body),
    );

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "consumer-test-credential" }),
    ]));
  });

  test.each([
    "Section overview pending",
    "TODO",
    "TBD",
    "Coming soon",
    "placeholder text",
  ])("detects unfinished content marker: %s", (marker) => {
    const report = validateConsumerPage(
      pageWithContent("overview", "overview.md", "Overview", `Details: ${marker}.`),
    );

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "placeholder-content" }),
    ]));
  });

  describe("Quickstart contract", () => {
    test("rejects prose above the bounded Quickstart budget", () => {
      const report = validateQuickstart(
        `## Run it\n\n${Array.from({ length: 651 }, () => "word").join(" ")}`,
      );

      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "quickstart-too-long", severity: "warning" }),
      ]));
    });

    test("does not apply the Quickstart word budget to an ordinary guide", () => {
      const report = validateConsumerPage(
        pageWithContent(
          "overview",
          "overview.md",
          "Overview",
          Array.from({ length: 651 }, () => "word").join(" "),
        ),
      );

      expect(report.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "quickstart-too-long" }),
      ]));
    });

    test.each([
      ["plain variable", '```bash\ncurl "$API_URL/health"\n```', "API_URL"],
      ["braced variable", '```sh\ncurl "${API_URL}/health"\n```', "API_URL"],
      [
        "variable used before a later assignment",
        '```zsh\ncurl "$API_URL/health"\nAPI_URL=https://api.example.com\n```',
        "API_URL",
      ],
    ])("rejects an undefined shell variable: %s", (_name, body, variable) => {
      const report = validateQuickstart(body);

      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule: "quickstart-undefined-shell-variable",
          message: expect.stringContaining(variable),
        }),
      ]));
    });

    test.each([
      [
        "ordinary assignment",
        '```bash\nAPI_URL=https://api.example.com\ncurl "$API_URL/health"\n```',
      ],
      [
        "export assignment",
        '```sh\nexport API_URL=https://api.example.com\ncurl "${API_URL}/health"\n```',
      ],
      [
        "dotenv definition",
        '```dotenv\nAPI_URL=https://api.example.com\n```\n\n```bash\ncurl "$API_URL/health"\n```',
      ],
      ["standard shell variable", '```bash\ncd "$HOME"\n```'],
      ["escaped dollar sign", '```bash\nprintf "\\$NOT_A_VARIABLE"\n```'],
    ])("accepts a defined or standard shell variable: %s", (_name, body) => {
      const report = validateQuickstart(body);

      expect(report.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "quickstart-undefined-shell-variable" }),
      ]));
    });

    test("rejects a constructed SDK client that is never imported", () => {
      const report = validateQuickstart(
        "```ts\nconst client = new FlagForgeClient({ apiKey: \"key\" });\n```",
      );

      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule: "quickstart-missing-import",
          excerpt: "new FlagForgeClient",
        }),
      ]));
    });

    test.each([
      [
        "named import",
        '```ts\nimport { FlagForgeClient } from "@flagforge/sdk";\nnew FlagForgeClient();\n```',
      ],
      [
        "aliased import",
        '```ts\nimport { FlagForgeClient as Client } from "@flagforge/sdk";\nnew Client();\n```',
      ],
      [
        "default import",
        '```js\nimport FlagForgeClient from "@flagforge/sdk";\nnew FlagForgeClient();\n```',
      ],
      [
        "CommonJS destructuring",
        '```js\nconst { FlagForgeClient } = require("@flagforge/sdk");\nnew FlagForgeClient();\n```',
      ],
      [
        "local class",
        "```ts\nclass LocalClient {}\nnew LocalClient();\n```",
      ],
      ["JavaScript global", "```js\nnew URL(\"https://example.com\");\n```"],
    ])("accepts an available JavaScript constructor: %s", (_name, body) => {
      const report = validateQuickstart(body);

      expect(report.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "quickstart-missing-import" }),
      ]));
    });

    test("accepts the source-backed canonical install command", () => {
      const report = validateQuickstart(
        "```bash\npnpm add @flagforge/sdk\n```",
        quickstartAnalysis(),
      );

      expect(report.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule: expect.stringMatching(/^quickstart-(?:missing-canonical|ungrounded)-install$/),
        }),
      ]));
    });

    test.each([
      ["JavaScript", "npm install @invented/sdk"],
      ["Python", "python -m pip install invented-sdk"],
      ["Rust", "cargo add invented-sdk"],
      ["Go", "go get example.com/invented/sdk"],
      ["C and C++", "vcpkg install invented-sdk"],
      ["CMake", "cmake --install build"],
      [".NET", "dotnet add package Invented.Sdk"],
      ["Homebrew", "brew install invented-sdk"],
    ])("rejects an ungrounded %s install command", (_name, command) => {
      const report = validateQuickstart(
        `\`\`\`bash\n${command}\n\`\`\``,
        quickstartAnalysis(),
      );

      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule: "quickstart-ungrounded-install",
          excerpt: command,
        }),
      ]));
    });

    test("warns, without blocking, when the canonical install is missing", () => {
      const report = validateQuickstart(
        "Use the SDK to evaluate your first flag.",
        quickstartAnalysis(),
      );

      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "quickstart-missing-canonical-install", severity: "warning" }),
      ]));
    });

    test("ignores install steps that are not shell commands", () => {
      const analysis = quickstartAnalysis();
      analysis.documentationIntent!.canonicalWorkflows[0]!.installCommands = [
        "Cursor: open the Extensions panel, search 'AI Memory', and click Install",
      ];

      const report = validateQuickstart("Install the extension from the Extensions panel.", analysis);

      expect(report.issues.filter((issue) => issue.rule.endsWith("-install"))).toEqual([]);
    });
  });

  test("does not match placeholder tokens inside a larger identifier", () => {
    const report = validateConsumerPage(
      pageWithContent(
        "overview",
        "overview.md",
        "Overview",
        "The TBDCompany identifier and coming_soon event name are literal API values.",
      ),
    );

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "placeholder-content" }),
    ]));
  });
});
