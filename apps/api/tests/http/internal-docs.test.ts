import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  DocsDomainResolution,
  DocsHostResolution,
} from "@doxahq/contracts";

const mocks = vi.hoisted(() => ({
  docsRepository: {
    resolveBySlug: vi.fn(),
    resolveGenerationPreview: vi.fn(),
  },
  docsDomainsRepository: {
    resolveByHostname: vi.fn(),
    findCanonicalHostname: vi.fn(async (): Promise<string | null> => null),
  },
  previewChannelsRepository: {
    resolveByHostname: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

vi.mock("@doxahq/auth", () => ({
  createAuth: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("../../src/repositories/docs", () => ({
  DocsRepository: vi.fn(() => mocks.docsRepository),
}));

vi.mock("../../src/repositories/docs-domains", () => ({
  DocsDomainsRepository: vi.fn(() => mocks.docsDomainsRepository),
}));

vi.mock("../../src/repositories/preview-channels", () => ({
  PreviewChannelsRepository: vi.fn(() => mocks.previewChannelsRepository),
}));

vi.mock("../../src/repositories/github", () => ({
  GitHubRepository: vi.fn(),
}));

vi.mock("../../src/repositories/jobs", () => ({
  JobsRepository: vi.fn(),
}));

vi.mock("../../src/repositories/projects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/repositories/projects")>();
  return {
    ...actual,
    ProjectsRepository: vi.fn(),
  };
});

vi.mock("../../src/services/container-generation", () => ({
  runContainerGeneration: vi.fn(),
}));

vi.mock("../../src/services/github-app", () => ({
  createInstallationAccessToken: vi.fn(),
  createRepositoryReadToken: vi.fn(),
  storeGenerationSiteAsset: vi.fn(),
  createModelAccessToken: vi.fn(async () => null),
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

const worker = (await import("../../src/index")).default;

describe("internal docs host routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.docsRepository.resolveBySlug.mockResolvedValue(null);
    mocks.docsRepository.resolveGenerationPreview.mockResolvedValue(null);
    mocks.previewChannelsRepository.resolveByHostname.mockResolvedValue(null);
  });

  test("resolves a verified docs hostname", async () => {
    mocks.docsDomainsRepository.resolveByHostname.mockResolvedValue(
      createResolution(),
    );

    const response = await worker.fetch(
      new Request("http://localhost:8787/internal/docs-hosts/Docs.Example.com"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsDomainsRepository.resolveByHostname).toHaveBeenCalledWith(
      "Docs.Example.com",
    );
    expect(mocks.docsRepository.resolveBySlug).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      site: createResolution(),
    });
  });

  test("resolves generated Doxa preview hostnames from the project slug", async () => {
    mocks.docsDomainsRepository.resolveByHostname.mockResolvedValue(null);
    mocks.docsRepository.resolveBySlug.mockResolvedValue(
      createSiteResolution(),
    );

    const response = await worker.fetch(
      new Request(
        "http://localhost:8787/internal/docs-hosts/Doxa-Demo.Doxa.Page",
      ),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsDomainsRepository.resolveByHostname).toHaveBeenCalledWith(
      "Doxa-Demo.Doxa.Page",
    );
    expect(mocks.docsRepository.resolveBySlug).toHaveBeenCalledWith(
      "doxa-demo",
    );
    await expect(response.json()).resolves.toEqual({
      site: createResolution({
        hostname: "doxa-demo.doxa.page",
        domainKind: "doxa_subdomain",
      }),
    });
  });

  test("marks the doxa.page hostname of a site with a working custom domain for a redirect", async () => {
    mocks.docsDomainsRepository.resolveByHostname.mockResolvedValue(null);
    mocks.docsRepository.resolveBySlug.mockResolvedValue(
      createSiteResolution(),
    );
    mocks.docsDomainsRepository.findCanonicalHostname.mockResolvedValueOnce(
      "docs.example.com",
    );

    const response = await worker.fetch(
      new Request("http://localhost:8787/internal/docs-hosts/doxa-demo.doxa.page"),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    await expect(response.json()).resolves.toEqual({
      site: createResolution({
        hostname: "doxa-demo.doxa.page",
        domainKind: "doxa_subdomain",
        canonicalHostname: "docs.example.com",
      }),
    });
    expect(mocks.docsDomainsRepository.findCanonicalHostname).toHaveBeenCalledWith(
      createSiteResolution().siteId,
    );
  });

  test("resolves an active pull-request preview before the production slug", async () => {
    const previewResolution = createResolution({
      publishedVersionId: "preview-version-1",
      artifactPrefix: "sites/site-1/versions/preview-version-1",
      manifestPath: "sites/site-1/versions/preview-version-1/manifest.json",
      hostname: "doxa-demo-pr-42.doxa.page",
      renderTarget: "preview",
    });
    mocks.docsDomainsRepository.resolveByHostname.mockResolvedValue(null);
    mocks.previewChannelsRepository.resolveByHostname.mockResolvedValue(
      previewResolution,
    );

    const response = await worker.fetch(
      new Request(
        "http://localhost:8787/internal/docs-hosts/doxa-demo-pr-42.doxa.page",
      ),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsRepository.resolveBySlug).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      site: previewResolution,
    });
  });

  test.each(["source_change", "branch"] as const)(
    "keeps the %s preview kind, so the dispatcher can choose the banner",
    async (previewKind) => {
      const previewResolution = createResolution({
        hostname: "doxa-demo-pr-42.doxa.page",
        previewKind,
      });
      mocks.docsDomainsRepository.resolveByHostname.mockResolvedValue(null);
      mocks.previewChannelsRepository.resolveByHostname.mockResolvedValue(previewResolution);

      const response = await worker.fetch(
        new Request("http://localhost:8787/internal/docs-hosts/doxa-demo-pr-42.doxa.page"),
        createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
        createExecutionContext(),
      );

      await expect(response.json()).resolves.toMatchObject({
        site: { renderTarget: "preview", previewKind },
      });
    },
  );

  test("resolves a permanent generation preview before other domains", async () => {
    const previewResolution = createResolution({
      publishedVersionId: "a1b2c3d4-e5f6-4789-8123-456789abcdef",
      hostname: "doxa-demo--a1b2c3d4e5f6.doxa.page",
      accessPolicy: "authenticated",
    });
    mocks.docsRepository.resolveGenerationPreview.mockResolvedValue(
      previewResolution,
    );

    const response = await worker.fetch(
      new Request(
        "http://localhost:8787/internal/docs-hosts/doxa-demo--a1b2c3d4e5f6.doxa.page",
      ),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsRepository.resolveGenerationPreview).toHaveBeenCalledWith({
      hostname: "doxa-demo--a1b2c3d4e5f6.doxa.page",
      projectSlug: "doxa-demo",
      versionIdPrefix: "a1b2c3d4e5f6",
    });
    expect(
      mocks.docsDomainsRepository.resolveByHostname,
    ).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      site: {
        ...previewResolution,
        renderTarget: "generation_snapshot",
      },
    });
  });

  test("exposes access policy without opening other internal routes", async () => {
    mocks.docsRepository.resolveGenerationPreview.mockResolvedValue(
      createResolution({
        hostname: "doxa-demo--a1b2c3d4e5f6.doxa.page",
        accessPolicy: "public",
      }),
    );

    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/internal/docs-access/doxa-demo--a1b2c3d4e5f6.doxa.page",
      ),
      createEnv({
        ALLOW_INTERNAL_HTTP: "false",
        DOCS_BASE_DOMAIN: "doxa.page",
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    await expect(response.json()).resolves.toEqual({ policy: "public" });
  });

  test("fails closed for an unknown access-policy hostname", async () => {
    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/internal/docs-access/missing--a1b2c3d4e5f6.doxa.page",
      ),
      createEnv({
        ALLOW_INTERNAL_HTTP: "false",
        DOCS_BASE_DOMAIN: "doxa.page",
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      policy: "authenticated",
    });
  });

  test("does not resolve non-generation hosts through the public policy route", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/internal/docs-access/docs.example.com"),
      createEnv({
        ALLOW_INTERNAL_HTTP: "false",
        DOCS_BASE_DOMAIN: "doxa.page",
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      policy: "authenticated",
    });
    expect(
      mocks.docsDomainsRepository.resolveByHostname,
    ).not.toHaveBeenCalled();
    expect(
      mocks.docsRepository.resolveGenerationPreview,
    ).not.toHaveBeenCalled();
  });

  test("returns 404 for unknown, disabled, unverified, or non-generated hostnames", async () => {
    mocks.docsDomainsRepository.resolveByHostname.mockResolvedValue(null);

    const response = await worker.fetch(
      new Request(
        "http://localhost:8787/internal/docs-hosts/pending.example.com",
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(mocks.docsRepository.resolveBySlug).not.toHaveBeenCalled();
  });

  test("returns 404 when generated hostnames have no published docs site", async () => {
    mocks.docsDomainsRepository.resolveByHostname.mockResolvedValue(null);
    mocks.docsRepository.resolveBySlug.mockResolvedValue(null);

    const response = await worker.fetch(
      new Request(
        "http://localhost:8787/internal/docs-hosts/missing.doxa.page",
      ),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(mocks.docsRepository.resolveBySlug).toHaveBeenCalledWith("missing");
  });

  test("returns 400 for malformed encoded hostnames", async () => {
    const response = await worker.fetch(
      new Request("http://localhost:8787/internal/docs-hosts/%E0%A4%A"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Invalid docs hostname." },
    });
    expect(
      mocks.docsDomainsRepository.resolveByHostname,
    ).not.toHaveBeenCalled();
  });
});

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    ALLOW_INTERNAL_HTTP: "true",
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

function createSiteResolution(): DocsHostResolution {
  return {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "doxa-demo",
    publishedVersionId: "version-1",
    artifactPrefix: "sites/site-1/versions/version-1",
    manifestPath: "sites/site-1/versions/version-1/manifest.json",
    accessPolicy: "public",
  };
}

function createResolution(
  overrides: Partial<DocsDomainResolution> = {},
): DocsDomainResolution {
  return {
    ...createSiteResolution(),
    hostname: "docs.example.com",
    domainKind: "custom_domain",
    renderTarget: "production",
    ...overrides,
  };
}
