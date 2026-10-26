import { beforeEach, describe, expect, test, vi } from "vitest";
import { createValidationIssue } from "@doxahq/site-config";
import { SiteConfigValidationError } from "../../src/services/site-config-validation";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  discardBranch: vi.fn(),
  docsContentService: {
    getOverview: vi.fn(),
    getPage: vi.fn(),
    applyEdits: vi.fn(),
    getMdxReport: vi.fn(),
  },
}));

vi.mock("../../src/services/agent-access/project-access-repository", async () => {
  const { SessionOwnedProjectAccess } = await import("../support/session-owned-project-access");
  return { ProjectAccessRepository: SessionOwnedProjectAccess };
});
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

vi.mock("@doxahq/auth", () => ({
  createAuth: vi.fn(),
  getSessionUser: mocks.getSessionUser,
  getTrustedOrigins: (env: { WEB_ORIGIN?: string }) => [env.WEB_ORIGIN].filter(Boolean),
}));

vi.mock("../../src/services/docs-content/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/docs-content/service")>();
  return {
    ...actual,
    DocsContentService: {
      ...actual.DocsContentService,
      fromEnv: () => mocks.docsContentService,
    },
  };
});

vi.mock("../../src/repositories/docs", () => ({ DocsRepository: vi.fn() }));
vi.mock("../../src/repositories/docs-branches", () => ({
  DocsBranchesRepository: class {
    discard = mocks.discardBranch;
  },
}));
vi.mock("../../src/repositories/github", () => ({ GitHubRepository: vi.fn() }));
vi.mock("../../src/repositories/jobs", () => ({ JobsRepository: vi.fn() }));

vi.mock("../../src/repositories/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/projects")>();
  return { ...actual, ProjectsRepository: vi.fn() };
});

vi.mock("../../src/services/container-generation", () => ({
  runContainerGeneration: vi.fn(),
}));

vi.mock("../../src/services/github-app", () => ({
  createInstallationAccessToken: vi.fn(),
  createRepositoryReadToken: vi.fn(),
  listInstallationRepositories: vi.fn(),
}));

vi.mock("../../src/services/github-webhook", () => ({
  verifyGitHubWebhook: vi.fn(),
}));

vi.mock("../../src/services/local-dev-user", () => ({
  ensureLocalDevUser: vi.fn(),
}));

vi.mock("../../src/services/starter-docs", () => ({
  publishStarterDocs: vi.fn(),
}));

const { DocsContentError } = await import("../../src/services/docs-content/service");
const worker = (await import("../../src/index")).default;

const overview = {
  projectId: "11111111-1111-4111-8111-111111111111",
  projectSlug: "flagforge",
  siteId: "site-1",
  publishedVersion: {
    id: "version-1",
    versionNumber: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  working: { branchId: null, baseVersionId: "version-1", editedHrefs: [], changeCount: 0, revision: 0, createdAt: null, updatedAt: null, isBaseCurrent: true },
  pages: [
    { href: "/", title: "Overview", sourcePath: "source/index.mdx", status: "published", icon: null },
  ],
  navigation: [],
};

describe("docs content routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "user@doxa.so" });
    mocks.docsContentService.getOverview.mockResolvedValue(overview);
  });

  test("returns the content overview for an owned project", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/content?branch=main"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsContentService.getOverview).toHaveBeenCalledWith(
      { userId: "user-1", origin: "editor" },
      "11111111-1111-4111-8111-111111111111",
      "main",
    );
    await expect(response.json()).resolves.toEqual({ content: overview });
  });

  test("requires a branch on content reads and edits", async () => {
    const read = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/content"),
      createEnv(),
      createExecutionContext(),
    );
    const edit = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/content/edits", {
        method: "POST",
        headers: { origin: "https://doxa.so", "content-type": "application/json" },
        body: JSON.stringify({ edits: [{ type: "reset_site_config" }] }),
      }),
      createEnv(),
      createExecutionContext(),
    );
    expect(read.status).toBe(400);
    expect(edit.status).toBe(400);
    expect(mocks.docsContentService.getOverview).not.toHaveBeenCalled();
    expect(mocks.docsContentService.applyEdits).not.toHaveBeenCalled();
  });

  test.each([
    { config: { theme: { primary: "red;position:fixed" } }, code: "invalid_color", path: "/theme/primary" },
    { config: { theme: { radius: "calc(2px)" } }, code: "invalid_length", path: "/theme/radius" },
    { config: { theme: { fonts: { body: "evil" } } }, code: "unknown_font", path: "/theme/fonts/body" },
    { config: { theme: { preset: "evil" } }, code: "unknown_preset", path: "/theme/preset" },
    { config: { navbar: { links: [{ label: "Click", href: "javascript:alert(1)" }] } }, code: "unsafe_href_protocol", path: "/navbar/links/0/href" },
    { config: { branding: { favicon: "https://evil.test/x" } }, code: "invalid_asset_ref", path: "/branding/favicon" },
    { config: { name: "x".repeat(81) }, code: "too_long", path: "/name" },
    { config: { name: "bad\u0001value" }, code: "invalid_text", path: "/name" },
    { config: { name: 123 }, code: "invalid_type", path: "/name" },
    { config: { badKey: "private rejected value" }, code: "unknown_key", path: "/badKey" },
    { config: { seo: { keywords: Array(21).fill("word") } }, code: "too_many_items", path: "/seo/keywords" },
  ])("returns 422 for $code", async ({ config, code, path }) => {
    const response = await worker.fetch(createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", { body: JSON.stringify({ edits: [{ type: "set_site_config", config }] }) }), createEnv(), createExecutionContext());
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { details: { code: "validation_failed", issues: [expect.objectContaining({ code, path })] } } });
    expect(mocks.docsContentService.applyEdits).not.toHaveBeenCalled();
  });

  test("returns all config issues without rejected values", async () => {
    const marker = "private-secret-attack";
    const response = await worker.fetch(createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", { body: JSON.stringify({ edits: [{ type: "set_site_config", config: { theme: { primary: marker }, navbar: { links: [{ label: "Link", href: `javascript:${marker}` }] } } }] }) }), createEnv(), createExecutionContext());
    const text = await response.text();
    expect(response.status).toBe(422);
    expect(text).not.toContain(marker);
    expect(JSON.parse(text).error.details.issues).toHaveLength(2);
  });

  test("maps API-only validation errors to 422", async () => {
    mocks.docsContentService.applyEdits.mockRejectedValueOnce(new SiteConfigValidationError([createValidationIssue("entitlement_required", "/branding/poweredBy")]));
    const response = await worker.fetch(createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", { body: JSON.stringify({ edits: [{ type: "set_site_config", config: {} }] }) }), createEnv(), createExecutionContext());
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { details: { code: "validation_failed", issues: [expect.objectContaining({ code: "entitlement_required" })] } } });
  });

  test("requires authentication", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/content?branch=main"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(mocks.docsContentService.getOverview).not.toHaveBeenCalled();
  });

  test("reads one page by href", async () => {
    mocks.docsContentService.getPage.mockResolvedValue({
      href: "/rest-api",
      title: "Rest API",
      sourcePath: "source/rest-api/index.mdx",
      status: "published",
      publishedContent: "# Rest API\n",
      workingContent: null,
    });

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/content/page?href=%2Frest-api&branch=main"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsContentService.getPage).toHaveBeenCalledWith(
      { userId: "user-1", origin: "editor" },
      "11111111-1111-4111-8111-111111111111",
      "/rest-api",
      "main",
    );
  });

  test("rejects a page read without an href", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/content/page?branch=main"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.docsContentService.getPage).not.toHaveBeenCalled();
  });

  test("applies an edit list with the editor origin", async () => {
    mocks.docsContentService.applyEdits.mockResolvedValue(null);

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", {
        body: JSON.stringify({
          edits: [{ type: "set_page_content", href: "/", content: "# Overview\n" }],
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsContentService.applyEdits).toHaveBeenCalledWith(
      { userId: "user-1", origin: "editor" },
      "11111111-1111-4111-8111-111111111111",
      [{ type: "set_page_content", href: "/", content: "# Overview\n" }],
      "main",
    );
  });

  test("saves a page with invalid MDX and returns its issues (spec 8.1)", async () => {
    mocks.docsContentService.applyEdits.mockResolvedValue(overview.working);

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", {
        body: JSON.stringify({
          edits: [
            { type: "set_page_content", href: "/", content: "# Overview\n\n<Bogus>Hi</Bogus>\n" },
            { type: "set_page_content", href: "/fine", content: "# Fine\n" },
          ],
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsContentService.applyEdits).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      working: overview.working,
      mdxIssues: [
        {
          href: "/",
          sourcePath: "source/index.mdx",
          issues: [{ line: 3, column: 1, message: "Unknown MDX component: Bogus" }],
        },
      ],
    });
  });

  test("returns the MDX report of a branch", async () => {
    const report = {
      pages: [
        {
          href: "/",
          sourcePath: "source/index.mdx",
          issues: [{ line: 3, column: 1, message: "Unknown MDX component: Bogus" }],
        },
      ],
    };
    mocks.docsContentService.getMdxReport.mockResolvedValue(report);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/content/mdx-issues?branch=main"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsContentService.getMdxReport).toHaveBeenCalledWith(
      { userId: "user-1", origin: "editor" },
      "11111111-1111-4111-8111-111111111111",
      "main",
    );
    await expect(response.json()).resolves.toEqual(report);
  });

  test("rejects a client-supplied origin before reaching the service", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", {
        body: JSON.stringify({
          origin: "mcp",
          edits: [{ type: "set_page_content", href: "/", content: "# Overview\n" }],
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.docsContentService.applyEdits).not.toHaveBeenCalled();
  });

  test("returns the current revision with a conflict", async () => {
    mocks.docsContentService.applyEdits.mockRejectedValueOnce(
      new DocsContentError("conflict", "The branch changed.", { currentRevision: 4 }),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", {
        body: JSON.stringify({
          edits: [{ type: "set_page_content", href: "/", content: "# Overview\n" }],
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "The branch changed.",
        details: { code: "conflict", currentRevision: 4 },
      },
    });
  });

  test("rejects an unknown edit type before reaching the service", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/edits", {
        body: JSON.stringify({ edits: [{ type: "delete_everything" }] }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.docsContentService.applyEdits).not.toHaveBeenCalled();
  });

  test("removed draft and publish routes return 404", async () => {
    const publish = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/publish"),
      createEnv(),
      createExecutionContext(),
    );
    const draft = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/content/draft", { method: "DELETE" }),
      createEnv(),
      createExecutionContext(),
    );
    expect(publish.status).toBe(404);
    expect(draft.status).toBe(404);
  });

  test("discards main through the branch route", async () => {
    mocks.discardBranch.mockResolvedValue({ revision: 2, collectEntryIds: [] });
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/branches/main/discard"),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(mocks.discardBranch).toHaveBeenCalledWith({
      userId: "user-1", projectId: "11111111-1111-4111-8111-111111111111", branch: "main",
    });
    await expect(response.json()).resolves.toEqual({ revision: 2 });
  });

  test("maps an unknown project to 404", async () => {
    mocks.docsContentService.getOverview.mockRejectedValue(
      new DocsContentError("not_found", "This project has no published documentation to edit yet."),
    );

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/33333333-3333-4333-8333-333333333333/content?branch=main"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });


});

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    WEB_ORIGIN: "https://doxa.so",
    GENERATION_QUEUE: { send: vi.fn() },
    DOCS_BUCKET: {},
    ...overrides,
  } as never;
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function createMutationRequest(pathname: string, init: RequestInit = {}): Request {
  const body = pathname.endsWith("/content/edits") && typeof init.body === "string"
    ? JSON.stringify({ ...JSON.parse(init.body), branch: "main" })
    : init.body;
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", "https://doxa.so");
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  return new Request(`https://api.doxa.so${pathname}`, {
    ...init,
    body,
    method: init.method ?? "POST",
    headers,
  });
}
