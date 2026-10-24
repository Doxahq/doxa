import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DocsDomainDto } from "@doxahq/contracts";
import type { DocsDomainProvisioningState } from "../../src/repositories/docs-domains";
import type { DocsDomainRoutingState } from "../../src/services/docs-domain-routing";

const mocks = vi.hoisted(() => ({
  repository: {
    listForProject: vi.fn(),
    createCustomDomain: vi.fn(),
    getForProject: vi.fn(),
    applyProvisioning: vi.fn(),
    deleteForProject: vi.fn(),
  },
  customHostnames: {
    create: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
  routingProbe: {
    check: vi.fn(),
  },
  createCloudflareCustomHostnamesClient: vi.fn(),
  createDocsDomainRoutingProbe: vi.fn(),
}));

vi.mock("../../src/repositories/docs-domains", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/repositories/docs-domains")
    >();
  return {
    ...actual,
    DocsDomainsRepository: vi.fn(() => mocks.repository),
  };
});

vi.mock(
  "../../src/services/cloudflare-custom-hostnames",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/services/cloudflare-custom-hostnames")
      >();
    return {
      ...actual,
      createCloudflareCustomHostnamesClient:
        mocks.createCloudflareCustomHostnamesClient,
    };
  },
);

vi.mock("../../src/services/docs-domain-routing", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/services/docs-domain-routing")
    >();
  return {
    ...actual,
    createDocsDomainRoutingProbe: mocks.createDocsDomainRoutingProbe,
  };
});

const { DocsDomainLifecycleService, DocsDomainProvisioningError } =
  await import("../../src/services/docs-domain-lifecycle");

describe("DocsDomainLifecycleService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repository.createCustomDomain.mockResolvedValue(createDomain());
    mocks.repository.getForProject.mockResolvedValue(
      createDomain({
        provider: "cloudflare",
        providerHostnameId: "hostname-1",
      }),
    );
    mocks.repository.applyProvisioning.mockResolvedValue(
      createDomain({
        status: "active",
        provider: "cloudflare",
        providerHostnameId: "hostname-1",
      }),
    );
    mocks.repository.deleteForProject.mockResolvedValue(true);
    mocks.customHostnames.create.mockResolvedValue(createProvisioning());
    mocks.customHostnames.get.mockResolvedValue(
      createProvisioning({ verificationStatus: "verified" }),
    );
    mocks.customHostnames.delete.mockResolvedValue(undefined);
    mocks.routingProbe.check.mockResolvedValue(createRoutingCheck());
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(null);
    mocks.createDocsDomainRoutingProbe.mockReturnValue(mocks.routingProbe);
  });

  test("creates local pending domains when Cloudflare provisioning is not configured", async () => {
    const service = new DocsDomainLifecycleService(createEnv());

    await expect(
      service.createCustomDomain({
        userId: "user-1",
        projectId: "project-1",
        hostname: "docs.example.com",
        docsBaseDomain: "doxa.so",
      }),
    ).resolves.toEqual(createDomain());
    expect(mocks.customHostnames.create).not.toHaveBeenCalled();
    expect(mocks.repository.applyProvisioning).not.toHaveBeenCalled();
  });

  test("adds the configured CNAME target to custom domain responses", async () => {
    mocks.repository.listForProject.mockResolvedValue([createDomain()]);
    const service = new DocsDomainLifecycleService(
      createEnv({
        DOCS_CUSTOM_DOMAIN_CNAME_TARGET: "Cname.Doxa.Page.",
      }),
    );

    await expect(
      service.listForProject({
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      domains: [
        createDomain({
          dnsRecord: {
            type: "CNAME",
            name: "docs.example.com",
            target: "cname.doxa.page",
            proxyStatus: "dns_only",
          },
        }),
      ],
      customDomainLimit: 1,
    });
  });

  test("resolves the custom domain limit through an injectable policy", async () => {
    const domainLimitPolicy = {
      getLimit: vi.fn().mockResolvedValue(3),
    };
    mocks.repository.listForProject.mockResolvedValue([]);
    const service = new DocsDomainLifecycleService(createEnv(), {
      domainLimitPolicy,
    });

    await expect(
      service.listForProject({
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      domains: [],
      customDomainLimit: 3,
    });
    expect(domainLimitPolicy.getLimit).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
    });
  });

  test("passes the resolved limit to the atomic domain create", async () => {
    const domainLimitPolicy = {
      getLimit: vi.fn().mockResolvedValue(2),
    };
    const service = new DocsDomainLifecycleService(createEnv(), {
      domainLimitPolicy,
    });

    await service.createCustomDomain({
      userId: "user-1",
      projectId: "project-1",
      hostname: "docs.example.com",
      docsBaseDomain: "doxa.page",
    });

    expect(mocks.repository.createCustomDomain).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      hostname: "docs.example.com",
      docsBaseDomain: "doxa.page",
      customDomainLimit: 2,
    });
  });

  test("does not add CNAME setup records to Doxa subdomains", async () => {
    mocks.repository.listForProject.mockResolvedValue([
      createDomain({
        hostname: "project.doxa.page",
        kind: "doxa_subdomain",
      }),
    ]);
    const service = new DocsDomainLifecycleService(
      createEnv({
        DOCS_CUSTOM_DOMAIN_CNAME_TARGET: "cname.doxa.page",
      }),
    );

    await expect(
      service.listForProject({
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      domains: [
        createDomain({
          hostname: "project.doxa.page",
          kind: "doxa_subdomain",
          dnsRecord: null,
        }),
      ],
      customDomainLimit: 1,
    });
  });

  test("applies Cloudflare provisioning metadata after custom hostname creation", async () => {
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(
      mocks.customHostnames,
    );
    const service = new DocsDomainLifecycleService(createEnv());

    await service.createCustomDomain({
      userId: "user-1",
      projectId: "project-1",
      hostname: "docs.example.com",
    });

    expect(mocks.customHostnames.create).toHaveBeenCalledWith(
      "docs.example.com",
    );
    expect(mocks.repository.applyProvisioning).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      domainId: "domain-1",
      status: "active",
      provisioning: createProvisioning(),
      routing: {
        status: "pending",
        httpStatus: null,
        error: null,
        checkedAt: null,
      },
    });
  });

  test("rolls back local domain records when provider creation fails", async () => {
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(
      mocks.customHostnames,
    );
    mocks.customHostnames.create.mockRejectedValue(
      new Error("provider unavailable"),
    );
    const service = new DocsDomainLifecycleService(createEnv());

    await expect(
      service.createCustomDomain({
        userId: "user-1",
        projectId: "project-1",
        hostname: "docs.example.com",
      }),
    ).rejects.toThrow("provider unavailable");
    expect(mocks.repository.deleteForProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      domainId: "domain-1",
    });
  });

  test("reads current provider status without restarting validation", async () => {
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(
      mocks.customHostnames,
    );
    mocks.customHostnames.get.mockResolvedValue(
      createProvisioning({
        providerStatus: "active",
        providerSslStatus: "active",
        verificationStatus: "verified",
      }),
    );
    const service = new DocsDomainLifecycleService(createEnv());

    await service.refreshForProject({
      userId: "user-1",
      projectId: "project-1",
      domainId: "domain-1",
    });

    expect(mocks.customHostnames.get).toHaveBeenCalledWith("hostname-1");
    expect(mocks.routingProbe.check).toHaveBeenCalledWith("docs.example.com");
    expect(mocks.repository.applyProvisioning).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      domainId: "domain-1",
      status: "active",
      provisioning: createProvisioning({
        providerStatus: "active",
        providerSslStatus: "active",
        verificationStatus: "verified",
      }),
      routing: createRoutingCheck(),
    });
  });

  test("emails the domain managers once verification ends", async () => {
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(mocks.customHostnames);
    mocks.repository.getForProject.mockResolvedValue(
      createDomain({ provider: "cloudflare", providerHostnameId: "hostname-1", verificationStatus: "pending" }),
    );
    mocks.repository.applyProvisioning.mockResolvedValue(
      createDomain({ status: "active", provider: "cloudflare", providerHostnameId: "hostname-1", verificationStatus: "verified" }),
    );
    const domainNotifier = { statusChanged: vi.fn(async () => undefined) };
    const service = new DocsDomainLifecycleService(createEnv(), { domainNotifier });

    await service.refreshForProject({ userId: "user-1", projectId: "project-1", domainId: "domain-1" });

    expect(domainNotifier.statusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", hostname: "docs.example.com", status: "active" }),
    );
  });

  test("sends nothing when the verification status does not change", async () => {
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(mocks.customHostnames);
    mocks.repository.getForProject.mockResolvedValue(
      createDomain({ provider: "cloudflare", providerHostnameId: "hostname-1", verificationStatus: "verified" }),
    );
    mocks.repository.applyProvisioning.mockResolvedValue(
      createDomain({ status: "active", provider: "cloudflare", providerHostnameId: "hostname-1", verificationStatus: "verified" }),
    );
    const domainNotifier = { statusChanged: vi.fn(async () => undefined) };
    const service = new DocsDomainLifecycleService(createEnv(), { domainNotifier });

    await service.refreshForProject({ userId: "user-1", projectId: "project-1", domainId: "domain-1" });

    expect(domainNotifier.statusChanged).not.toHaveBeenCalled();
  });

  test("deletes provider hostnames before deleting local domain records", async () => {
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(
      mocks.customHostnames,
    );
    const service = new DocsDomainLifecycleService(createEnv());

    await expect(
      service.deleteForProject({
        userId: "user-1",
        projectId: "project-1",
        domainId: "domain-1",
      }),
    ).resolves.toBe(true);
    expect(mocks.customHostnames.delete).toHaveBeenCalledWith("hostname-1");
    expect(mocks.repository.deleteForProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      domainId: "domain-1",
    });
  });

  test("does not delete Doxa-managed domains", async () => {
    mocks.repository.getForProject.mockResolvedValue(
      createDomain({
        hostname: "flagforge.doxa.page",
        kind: "doxa_subdomain",
      }),
    );
    const service = new DocsDomainLifecycleService(createEnv());

    await expect(
      service.deleteForProject({
        userId: "user-1",
        projectId: "project-1",
        domainId: "domain-1",
      }),
    ).rejects.toThrow("Doxa-managed domains cannot be deleted.");
    expect(mocks.customHostnames.delete).not.toHaveBeenCalled();
    expect(mocks.repository.deleteForProject).not.toHaveBeenCalled();
  });

  test("keeps the local record when provider deletion fails", async () => {
    mocks.createCloudflareCustomHostnamesClient.mockReturnValue(
      mocks.customHostnames,
    );
    mocks.customHostnames.delete.mockRejectedValue(
      new Error("provider unavailable"),
    );
    const service = new DocsDomainLifecycleService(createEnv());

    const deletion = service.deleteForProject({
        userId: "user-1",
        projectId: "project-1",
        domainId: "domain-1",
      });

    await expect(deletion).rejects.toThrow("provider unavailable");
    await expect(deletion).rejects.toBeInstanceOf(DocsDomainProvisioningError);
    expect(mocks.repository.deleteForProject).not.toHaveBeenCalled();
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

function createDomain(overrides: Partial<DocsDomainDto> = {}): DocsDomainDto {
  return {
    id: "domain-1",
    projectId: "project-1",
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

function createRoutingCheck(): DocsDomainRoutingState {
  return {
    status: "healthy",
    httpStatus: 307,
    error: null,
    checkedAt: new Date("2026-08-31T10:00:00.000Z"),
  };
}

function createProvisioning(
  overrides: Partial<DocsDomainProvisioningState> = {},
): DocsDomainProvisioningState {
  return {
    provider: "cloudflare",
    providerHostnameId: "hostname-1",
    providerStatus: "pending",
    providerSslStatus: "pending_validation",
    verificationStatus: "pending",
    ownershipVerification: {
      type: "txt",
      name: "_cf-custom-hostname.docs.example.com",
      value: "ownership-token",
    },
    ownershipVerificationHttp: {
      url: "http://docs.example.com/.well-known/cf-custom-hostname-challenge/hostname-1",
      body: "ownership-token",
    },
    sslValidationRecords: [
      {
        status: "pending",
        txtName: "_acme-challenge.docs.example.com",
        txtValue: "ssl-token",
        httpUrl: null,
        httpBody: null,
      },
    ],
    verificationError: null,
    ...overrides,
  };
}
