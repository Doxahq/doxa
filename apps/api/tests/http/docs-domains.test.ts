import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DocsDomainDto } from "@doxahq/contracts";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  docsDomainLifecycleService: {
    listForProject: vi.fn(),
    createCustomDomain: vi.fn(),
    refreshForProject: vi.fn(),
    deleteForProject: vi.fn(),
  },
  docsDomainDnsHostService: {
    detectForProject: vi.fn(),
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
  getTrustedOrigins: (env: { WEB_ORIGIN?: string }) =>
    [env.WEB_ORIGIN].filter(Boolean),
}));

vi.mock("../../src/repositories/docs-domains", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/repositories/docs-domains")
    >();
  return {
    ...actual,
    DocsDomainsRepository: vi.fn(),
  };
});

vi.mock("../../src/services/docs-domain-lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/services/docs-domain-lifecycle")
    >();
  return {
    ...actual,
    DocsDomainLifecycleService: vi.fn(() => mocks.docsDomainLifecycleService),
  };
});

vi.mock("../../src/services/docs-domain-dns-host", () => ({
  DocsDomainDnsHostService: vi.fn(() => mocks.docsDomainDnsHostService),
}));

vi.mock("../../src/repositories/docs", () => ({
  DocsRepository: vi.fn(),
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

const { CreateCustomDocsDomainError } =
  await import("../../src/repositories/docs-domains");
const { DocsDomainProvisioningError } =
  await import("../../src/services/docs-domain-lifecycle");
const worker = (await import("../../src/index")).default;

describe("docs domain routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({
      id: "user-1",
      email: "user@doxa.so",
    });
    mocks.docsDomainLifecycleService.listForProject.mockResolvedValue({
      domains: [createDomain()],
      customDomainLimit: 1,
    });
    mocks.docsDomainLifecycleService.createCustomDomain.mockResolvedValue(
      createDomain(),
    );
    mocks.docsDomainLifecycleService.refreshForProject.mockResolvedValue(
      createDomain({ verificationStatus: "verified" }),
    );
    mocks.docsDomainLifecycleService.deleteForProject.mockResolvedValue(true);
    mocks.docsDomainDnsHostService.detectForProject.mockResolvedValue({
      provider: "cloudflare",
      zone: "example.com",
      nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
  });

  test("lists docs domains for an owned project", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/docs-domains"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(
      mocks.docsDomainLifecycleService.listForProject,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(response.json()).resolves.toEqual({
      domains: [createDomain()],
      customDomainLimit: 1,
    });
  });

  test("creates a pending custom docs domain for an owned project", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/docs-domains", {
        body: JSON.stringify({ hostname: "Docs.Example.com" }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(
      mocks.docsDomainLifecycleService.createCustomDomain,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      hostname: "Docs.Example.com",
      docsBaseDomain: "doxa.page",
    });
    await expect(response.json()).resolves.toEqual({ domain: createDomain() });
  });

  test("rejects invalid create payloads before repository writes", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/docs-domains", {
        body: JSON.stringify({ hostname: "" }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(
      mocks.docsDomainLifecycleService.createCustomDomain,
    ).not.toHaveBeenCalled();
  });

  test("maps domain lifecycle errors to stable HTTP responses", async () => {
    mocks.docsDomainLifecycleService.createCustomDomain.mockRejectedValue(
      new CreateCustomDocsDomainError("hostname_taken"),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/docs-domains", {
        body: JSON.stringify({ hostname: "docs.example.com" }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "This hostname is already connected to another docs project.",
      },
    });
  });

  test("returns a friendly conflict when the project reaches its domain limit", async () => {
    mocks.docsDomainLifecycleService.createCustomDomain.mockRejectedValue(
      new CreateCustomDocsDomainError("project_domain_limit_reached"),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/docs-domains", {
        body: JSON.stringify({ hostname: "second.example.com" }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "This project has reached its custom domain limit.",
      },
    });
  });

  test("maps custom hostname provisioning errors to stable HTTP responses", async () => {
    mocks.docsDomainLifecycleService.createCustomDomain.mockRejectedValue(
      new DocsDomainProvisioningError(
        "Cloudflare custom hostname provisioning is not configured for this environment.",
        503,
      ),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/docs-domains", {
        body: JSON.stringify({ hostname: "docs.example.com" }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message:
          "Cloudflare custom hostname provisioning is not configured for this environment.",
      },
    });
  });

  test("returns 404 when listing domains for a project outside the user scope", async () => {
    mocks.docsDomainLifecycleService.listForProject.mockResolvedValue(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/33333333-3333-4333-8333-333333333333/docs-domains"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });

  test("returns the DNS host of a docs domain", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/docs-domains/domain-1/dns-host"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(
      mocks.docsDomainDnsHostService.detectForProject,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      domainId: "domain-1",
    });
    await expect(response.json()).resolves.toEqual({
      dnsHost: {
        provider: "cloudflare",
        zone: "example.com",
        nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      },
    });
  });

  test("returns 404 for the DNS host of a domain outside the project", async () => {
    mocks.docsDomainDnsHostService.detectForProject.mockResolvedValue(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/docs-domains/domain-9/dns-host"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });

  test("refreshes a docs domain for an owned project", async () => {
    const response = await worker.fetch(
      createMutationRequest(
        "/projects/11111111-1111-4111-8111-111111111111/docs-domains/domain-1/refresh",
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(
      mocks.docsDomainLifecycleService.refreshForProject,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      domainId: "domain-1",
    });
    await expect(response.json()).resolves.toEqual({
      domain: createDomain({ verificationStatus: "verified" }),
    });
  });

  test("deletes a docs domain for an owned project", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/docs-domains/domain-1", {
        method: "DELETE",
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(
      mocks.docsDomainLifecycleService.deleteForProject,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      domainId: "domain-1",
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  test("returns a stable error when provider deletion fails", async () => {
    mocks.docsDomainLifecycleService.deleteForProject.mockRejectedValue(
      new DocsDomainProvisioningError(
        "Cloudflare could not delete this custom hostname.",
        502,
      ),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/docs-domains/domain-1", {
        method: "DELETE",
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "Cloudflare could not delete this custom hostname.",
      },
    });
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

function createMutationRequest(
  pathname: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", "https://doxa.so");

  return new Request(`https://api.doxa.so${pathname}`, {
    ...init,
    method: init.method ?? "POST",
    headers,
  });
}

function createDomain(overrides: Partial<DocsDomainDto> = {}): DocsDomainDto {
  return {
    id: "domain-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    siteId: "site-1",
    hostname: "docs.example.com",
    kind: "custom_domain",
    status: "disabled",
    verificationStatus: "pending",
    provider: null,
    providerHostnameId: null,
    providerStatus: null,
    providerSslStatus: null,
    ownershipVerification: null,
    ownershipVerificationHttp: null,
    sslValidationRecords: [],
    dnsRecord: null,
    verificationError: null,
    routingStatus: "pending",
    routingHttpStatus: null,
    routingError: null,
    routingCheckedAt: null,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}
