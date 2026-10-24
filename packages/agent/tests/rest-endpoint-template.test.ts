import { parseRuntimeMdx } from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import { deterministicPageRendererFor } from "../src/doxa-agent/deterministic-pages";
import { prompts } from "../src/doxa-agent/prompts";
import { renderRestEndpointTemplatePage } from "../src/doxa-agent/rest-endpoint-template";
import { StructurePipelineDefectError } from "../src/doxa-agent/structure-review-errors";
import { restFrontmatterMetadata } from "../src/doxa-agent/rest-endpoint-page";
import { composePageDescription } from "../src/doxa-agent/writer";
import { runWriterAttempts } from "../src/doxa-agent/writer-pipeline";
import type {
  DocPage,
  DocumentationStructure,
  RestApiReferenceEndpoint,
  RestApiReferenceSurface,
  WriterContext,
} from "../src/types";
import { DEFAULT_WRITER_VALIDATION } from "../src/types";
import { parseFrontmatter } from "../src/utils/frontmatter";
import { runPageValidation } from "../src/utils/page-validator";
import { analysisFixture } from "./fixtures";

const createFlag: RestApiReferenceEndpoint = {
  id: "create-flag",
  title: "Create a flag",
  method: "POST",
  path: "/projects/{projectId}/flags",
  description: "Create a feature flag in one project and return the stored flag.",
  parameters: [
    { name: "projectId", in: "path", type: "string", required: true, description: "The project identifier." },
    { name: "dryRun", in: "query", type: "boolean", required: false },
  ],
  bodyFields: [
    { name: "key", type: "string", required: true, description: "Unique flag key." },
    { name: "enabled", type: "boolean", required: false, example: "true" },
  ],
  bodyContentType: "application/json",
  responses: [{
    status: 201,
    contentType: "application/json",
    example: '{\n  "key": "new-checkout"\n}',
    fields: [{ name: "key", type: "string", required: true, description: "Stored flag key." }],
  }],
  authRequirement: { scheme: "bearer", location: "header", name: "Authorization" },
  sourceEvidence: [{ path: "src/routes/flags.ts" }],
};

const listFlags: RestApiReferenceEndpoint = {
  id: "list-flags",
  title: "List flags",
  method: "GET",
  path: "/flags",
  description: "",
  sourceEvidence: [{ path: "src/routes/flags.ts" }],
};

function surfaceWith(
  endpoints: RestApiReferenceEndpoint[],
): RestApiReferenceSurface {
  return {
    label: "REST API",
    slug: "rest-api",
    baseUrl: "https://api.example.com/v1",
    sourceEvidence: [],
    authSchemes: [{ scheme: "bearer", location: "header", name: "Authorization" }],
    groups: [{
      id: "flags",
      title: "Flags",
      sourceEvidence: [],
      endpoints,
    }],
  };
}

function endpointPage(
  endpoint: RestApiReferenceEndpoint,
  overrides: Partial<DocPage> = {},
): DocPage {
  return {
    id: endpoint.id,
    title: endpoint.title,
    description: `Covers ${endpoint.method} ${endpoint.path} request data, responses, and errors.`,
    sourceEvidence: endpoint.sourceEvidence,
    audience: "reference",
    reference: {
      kind: "rest",
      pageKind: "endpoint",
      groupId: "flags",
      endpointId: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
    },
    ...overrides,
  };
}

function structureFor(pages: DocPage[]): DocumentationStructure {
  return {
    sections: [{
      id: "api",
      title: "REST API",
      pages: [
        {
          id: "authentication",
          title: "Authentication",
          description: "Send a bearer token with every request.",
          reference: { kind: "rest", pageKind: "auth" },
        },
        ...pages,
      ],
    }],
  };
}

function contextFor(
  endpoints: RestApiReferenceEndpoint[],
  structure: DocumentationStructure = structureFor(endpoints.map((endpoint) => endpointPage(endpoint))),
): WriterContext {
  return {
    analysis: {
      ...analysisFixture,
      referenceSurfaces: { rest: surfaceWith(endpoints) },
    },
    answers: {},
    structure,
  };
}

function render(page: DocPage, writerContext: WriterContext | undefined): Promise<string> {
  return renderRestEndpointTemplatePage({
    pageId: `api/${page.id}`,
    page,
    writerContext,
    writerValidation: DEFAULT_WRITER_VALIDATION,
    promptRegistry: prompts,
  });
}

async function expectPassesWriterGates(content: string): Promise<void> {
  await expect(runPageValidation(content, {
    preserveTitle: true,
    restEndpointPage: true,
  })).resolves.toEqual({ ok: true, issues: [] });
  expect(() => parseRuntimeMdx(content)).not.toThrow();
}

function frontmatterBlock(content: string): string {
  return content.slice(0, content.indexOf("---", 3) + 3);
}

describe("REST endpoint template pages", () => {
  test("selects the template only for endpoint pages", () => {
    expect(deterministicPageRendererFor(endpointPage(createFlag))?.id)
      .toBe("rest-endpoint-template-v4");
    for (const pageKind of ["overview", "auth", "group"] as const) {
      expect(deterministicPageRendererFor({
        reference: { kind: "rest", pageKind, groupId: "flags" },
      })).toBeUndefined();
    }
    expect(deterministicPageRendererFor({ reference: { kind: "sdk", exportId: "client" } }))
      .toBeUndefined();
    expect(deterministicPageRendererFor({})).toBeUndefined();
  });

  test("renders an endpoint with params, body, responses and auth from analysis only", async () => {
    const page = endpointPage(createFlag);
    const content = await render(page, contextFor([createFlag]));
    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toMatchObject({
      title: "Create a flag",
      apiMethod: "POST",
      apiPath: "/projects/{projectId}/flags",
    });
    expect(body.indexOf(createFlag.description)).toBeGreaterThan(-1);
    expect(body.indexOf(createFlag.description)).toBeLessThan(body.indexOf("<ApiEndpoint "));
    expect(body).toContain('<ApiEndpoint method="POST" path="/projects/&#123;projectId&#125;/flags"');
    for (const title of ["Authentication", "Path Parameters", "Query Parameters", "Body", "Response"]) {
      expect(body).toContain(`title="${title}"`);
    }
    expect(body).toContain('<ApiResponseExample status="201"');
    expect(body).toContain("See [Authentication](/api/authentication).");
    expect(content.trimEnd().endsWith("</ApiEndpoint>")).toBe(true);
    await expectPassesWriterGates(content);
  });

  test("renders a bare endpoint without a description, params, body, responses or auth", async () => {
    const content = await render(endpointPage(listFlags), contextFor([listFlags]));
    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toMatchObject({ title: "List flags", apiMethod: "GET", apiPath: "/flags" });
    // The page title is the heading; the body does not repeat it.
    expect(body).not.toContain("## List flags");
    expect(body.trim().startsWith("<ApiEndpoint ")).toBe(true);
    expect(body).not.toContain("<ApiParams");
    expect(body).not.toContain("<ApiResponseExample");
    expect(body).toContain('<ApiRequestExample client="curl"');
    await expectPassesWriterGates(content);
  });

  test("escapes analysis prose that MDX would read as JSX or an expression", async () => {
    const endpoint: RestApiReferenceEndpoint = {
      ...listFlags,
      description: "Return flags where <state> is {enabled} & sorted by key.",
    };
    const content = await render(endpointPage(endpoint), contextFor([endpoint]));

    expect(content).toContain("Return flags where");
    expect(content).not.toMatch(/[^\\]<state>/);
    expect(content).not.toMatch(/[^\\&#123;]\{enabled/);
    await expectPassesWriterGates(content);
  });

  test("writes the frontmatter the model writer writes when it gives no description", async () => {
    const page = endpointPage(createFlag);
    const content = await render(page, contextFor([createFlag]));
    const written = await runWriterAttempts({
      title: page.title,
      description: page.description,
      preserveTitle: true,
      ...restFrontmatterMetadata(page),
      maxAttempts: 1,
      validation: { mdxCompile: false, restEndpointPage: true },
      baseTokens: 1_000,
      expandedTokens: 2_000,
      runOnce: async () => ({
        text: [
          "Model prose for this endpoint explains what the call stores and returns.",
          "It also explains when a caller uses it instead of updating an existing flag,",
          "and it names the side effects that the reference tables cannot show.",
        ].join("\n"),
        finishReason: "stop",
      }),
      saveDebug: async () => "unused",
      composeDescription: (agentDescription) =>
        composePageDescription(prompts, agentDescription || page.description),
    });

    expect(frontmatterBlock(content)).toBe(frontmatterBlock(written.content));
  });

  test("omits the authentication link when the structure has no auth page", async () => {
    const page = endpointPage(createFlag);
    const structure: DocumentationStructure = {
      sections: [{ id: "api", title: "REST API", pages: [page] }],
    };
    const content = await render(page, contextFor([createFlag], structure));

    expect(content).toContain('title="Authentication"');
    expect(content).not.toContain("See [Authentication]");
    await expectPassesWriterGates(content);
  });

  test("writes a deprecation line before the description of a deprecated endpoint", async () => {
    const deprecated = { ...createFlag, deprecated: true };
    const content = await render(endpointPage(deprecated), contextFor([deprecated]));

    expect(parseFrontmatter(content).body).toMatch(
      /\*\*This endpoint is deprecated\.\*\*\n\nCreate a feature flag in one project/,
    );
    await expectPassesWriterGates(content);
  });

  test("labels a status range and a default response by their spec keys", async () => {
    const ranged: RestApiReferenceEndpoint = {
      ...createFlag,
      responses: [
        { status: 200, statusLabel: "2XX", contentType: "application/json", example: "{}" },
        { status: 0, statusLabel: "default", contentType: "application/json", example: "{}" },
      ],
    };
    const content = await render(endpointPage(ranged), contextFor([ranged]));

    expect(content).toContain('<ApiResponseExample status="2XX"');
    expect(content).toContain('<ApiResponseExample status="default"');
    await expectPassesWriterGates(content);
  });

  test("G4 keeps an import or export line of a description as text", async () => {
    const esm = { ...createFlag, description: "export const leaked = process.env\n\nimport fs from 'node:fs'" };
    const content = await render(endpointPage(esm), contextFor([esm]));

    expect(content).toContain("&#101;xport const leaked = process.env");
    expect(content).toContain("&#105;mport fs from 'node:fs'");
    expect(content).not.toMatch(/^export const leaked/m);
    await expectPassesWriterGates(content);
  });

  test("renders the same page for the same input", async () => {
    const page = endpointPage(createFlag);
    const context = contextFor([createFlag]);

    expect(await render(page, context)).toBe(await render(page, context));
  });

  test("fails as a pipeline defect when analysis lacks the endpoint", async () => {
    const page = endpointPage(createFlag);

    await expect(render(page, contextFor([listFlags]))).rejects.toBeInstanceOf(
      StructurePipelineDefectError,
    );
    await expect(render(page, undefined)).rejects.toThrow(
      /references endpoint "create-flag" in group "flags"/,
    );
  });
});
