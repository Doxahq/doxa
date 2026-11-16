import type { DocsDomainCollectionDto, DocsDomainDto } from "@doxahq/contracts";
import type { Env } from "../env";
import {
  CreateCustomDocsDomainError,
  DocsDomainsRepository,
  type DocsDomainProvisioningState,
} from "../repositories/docs-domains";
import {
  CloudflareCustomHostnameError,
  createCloudflareCustomHostnamesClient,
  type CloudflareCustomHostnamesClient,
} from "./cloudflare-custom-hostnames";
import type { DocsDomainLimitPolicy } from "./docs-domain-limit-policy";
import { planSeamsFromEnv } from "./billing/plan-seams";
import { domainNotifierFromEnv, type DomainNotifier } from "./email/notifications";
import {
  createDocsDomainRoutingProbe,
  createPendingDocsDomainRoutingState,
  type DocsDomainRoutingProbe,
  type DocsDomainRoutingState,
} from "./docs-domain-routing";
import { toSafeErrorLog } from "../http/error-log";

export class DocsDomainProvisioningError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

interface DocsDomainLifecycleDependencies {
  domainLimitPolicy?: DocsDomainLimitPolicy;
  domainNotifier?: DomainNotifier;
}

export class DocsDomainLifecycleService {
  private readonly domains: DocsDomainsRepository;
  private readonly customHostnames: CloudflareCustomHostnamesClient | null;
  private readonly customHostnamesConfigurationError: DocsDomainProvisioningError | null;
  private readonly customDomainCnameTarget: string | null;
  private readonly routingProbe: DocsDomainRoutingProbe;
  private readonly domainLimitPolicy: DocsDomainLimitPolicy;
  private readonly domainNotifier: DomainNotifier;
  private readonly officialDocsProjectId: string | undefined;

  constructor(env: Env, dependencies: DocsDomainLifecycleDependencies = {}) {
    this.domains = new DocsDomainsRepository(env);
    this.officialDocsProjectId = env.DOXA_OFFICIAL_DOCS_PROJECT_ID;
    const customHostnames = createCustomHostnamesClient(env);
    this.customHostnames = customHostnames.client;
    this.customHostnamesConfigurationError = customHostnames.configurationError;
    this.customDomainCnameTarget = normalizeOptionalHostname(env.DOCS_CUSTOM_DOMAIN_CNAME_TARGET);
    this.routingProbe = createDocsDomainRoutingProbe();
    this.domainLimitPolicy = dependencies.domainLimitPolicy ?? planSeamsFromEnv(env).docsDomainLimit;
    this.domainNotifier = dependencies.domainNotifier ?? domainNotifierFromEnv(env);
  }

  /** False in an environment without Cloudflare custom hostnames, such as local development. */
  get canCheckCustomDomains(): boolean {
    return this.customHostnames !== null;
  }

  async listForProject(input: { userId: string; projectId: string }): Promise<DocsDomainCollectionDto | null> {
    const domains = await this.domains.listForProject(input);
    if (!domains) return null;

    const customDomainLimit = await this.domainLimitPolicy.getLimit(input);
    return {
      domains: domains.map((domain) => this.withDnsRecord(domain)),
      customDomainLimit,
    };
  }

  async createCustomDomain(input: {
    userId: string;
    projectId: string;
    hostname: string;
    docsBaseDomain?: string;
  }): Promise<DocsDomainDto> {
    const customDomainLimit = await this.domainLimitPolicy.getLimit(input);
    const domain = await this.domains.createCustomDomain({
      ...input,
      officialDocsProjectId: this.officialDocsProjectId,
      customDomainLimit,
    });
    if (this.customHostnamesConfigurationError) {
      await this.domains.deleteForProject({
        userId: input.userId,
        projectId: input.projectId,
        domainId: domain.id,
      });
      throw this.customHostnamesConfigurationError;
    }

    if (!this.customHostnames) return this.withDnsRecord(domain);

    try {
      const provisioning = await this.customHostnames.create(domain.hostname);
      const routing = await this.checkRoutingIfReady(domain.hostname, provisioning);
      return await this.applyProvisioningOrThrow({
        userId: input.userId,
        projectId: input.projectId,
        domainId: domain.id,
        provisioning,
        routing,
      });
    } catch (err) {
      await this.domains.deleteForProject({
        userId: input.userId,
        projectId: input.projectId,
        domainId: domain.id,
      });
      throw toDocsDomainProvisioningError(err);
    }
  }

  async refreshForProject(input: {
    userId: string;
    projectId: string;
    domainId: string;
  }): Promise<DocsDomainDto | null> {
    const domain = await this.domains.getForProject(input);
    if (!domain) return null;
    if (!domain.provider || !domain.providerHostnameId) return this.withDnsRecord(domain);

    if (this.customHostnamesConfigurationError) throw this.customHostnamesConfigurationError;
    if (!this.customHostnames) throw createMissingCloudflareConfigError();

    const provisioning = await this.customHostnames.get(domain.providerHostnameId);
    const routing = await this.checkRoutingIfReady(domain.hostname, provisioning);
    const refreshed = await this.applyProvisioningOrThrow({
      userId: input.userId,
      projectId: input.projectId,
      domainId: domain.id,
      provisioning,
      routing,
    });
    await this.notifyVerificationChange(input.projectId, domain, refreshed);
    return refreshed;
  }

  /** Emails the domain managers when verification ends: verified (live) or failed. */
  private async notifyVerificationChange(projectId: string, before: DocsDomainDto, after: DocsDomainDto): Promise<void> {
    if (before.verificationStatus === after.verificationStatus) return;
    if (after.verificationStatus !== "verified" && after.verificationStatus !== "failed") return;
    await this.domainNotifier.statusChanged({
      projectId,
      domainId: after.id,
      hostname: after.hostname,
      status: after.verificationStatus === "verified" ? "active" : "failed",
      failureReason: after.verificationError,
      changedAt: new Date(),
    });
  }

  async deleteForProject(input: { userId: string; projectId: string; domainId: string }): Promise<boolean> {
    const domain = await this.domains.getForProject(input);
    if (!domain) return false;
    if (domain.kind !== "custom_domain") {
      throw new DocsDomainProvisioningError("Doxa-managed domains cannot be deleted.", 400);
    }

    if (domain.provider === "cloudflare" && domain.providerHostnameId) {
      if (this.customHostnamesConfigurationError) throw this.customHostnamesConfigurationError;
      if (!this.customHostnames) throw createMissingCloudflareConfigError();

      try {
        await this.customHostnames.delete(domain.providerHostnameId);
      } catch (err) {
        throw toDocsDomainProvisioningError(err);
      }
    }

    return this.domains.deleteForProject(input);
  }

  /**
   * Removes every Cloudflare custom hostname of a project before the project
   * is deleted. The domain rows stay: the project delete removes them.
   */
  async releaseCustomHostnamesForProject(input: { userId: string; projectId: string }): Promise<void> {
    const domains = (await this.domains.listForProject(input)) ?? [];
    const provisioned = domains.filter(
      (domain) => domain.provider === "cloudflare" && domain.providerHostnameId,
    );
    if (provisioned.length === 0) return;

    if (this.customHostnamesConfigurationError) throw this.customHostnamesConfigurationError;
    if (!this.customHostnames) throw createMissingCloudflareConfigError();

    for (const domain of provisioned) {
      try {
        await this.customHostnames.delete(domain.providerHostnameId as string);
      } catch (err) {
        throw toDocsDomainProvisioningError(err);
      }
    }
  }

  private async applyProvisioningOrThrow(input: {
    userId: string;
    projectId: string;
    domainId: string;
    provisioning: DocsDomainProvisioningState;
    routing: DocsDomainRoutingState;
  }): Promise<DocsDomainDto> {
    const updatedDomain = await this.domains.applyProvisioning({
      ...input,
      status: "active",
    });
    if (!updatedDomain) {
      throw new DocsDomainProvisioningError("Docs domain was not found after custom hostname provisioning.", 404);
    }

    return this.withDnsRecord(updatedDomain);
  }

  private checkRoutingIfReady(
    hostname: string,
    provisioning: DocsDomainProvisioningState,
  ): Promise<DocsDomainRoutingState> {
    if (provisioning.verificationStatus !== "verified") {
      return Promise.resolve(createPendingDocsDomainRoutingState());
    }

    return this.routingProbe.check(hostname);
  }

  private withDnsRecord(domain: DocsDomainDto): DocsDomainDto {
    if (domain.kind !== "custom_domain" || !this.customDomainCnameTarget) {
      return {
        ...domain,
        dnsRecord: null,
      };
    }

    return {
      ...domain,
      dnsRecord: {
        type: "CNAME",
        name: domain.hostname,
        target: this.customDomainCnameTarget,
        proxyStatus: "dns_only",
      },
    };
  }
}

export function getDocsDomainProvisioningStatus(err: DocsDomainProvisioningError): number {
  return err.status;
}

/**
 * SEC-032: the message goes to the dashboard and to agents, so it is one of
 * a fixed set. Cloudflare's own error text and any other error's text stay
 * in the server log only.
 */
function toDocsDomainProvisioningError(err: unknown): DocsDomainProvisioningError {
  if (err instanceof DocsDomainProvisioningError) return err;
  if (err instanceof CreateCustomDocsDomainError) throw err;
  console.error("Docs domain provisioning failed.", toSafeErrorLog(err));
  if (err instanceof CloudflareCustomHostnameError) {
    const status = err.status ?? 502;
    return new DocsDomainProvisioningError(providerErrorMessage(status), status);
  }
  return new DocsDomainProvisioningError(GENERIC_PROVISIONING_MESSAGE);
}

const GENERIC_PROVISIONING_MESSAGE = "Docs domain provisioning failed. Try again later.";

function providerErrorMessage(status: number): string {
  if (status === 409) return "This hostname is already in use on Cloudflare.";
  if (status === 400 || status === 422) {
    return "Cloudflare could not use this hostname. Check the hostname and its DNS record.";
  }
  if (status === 429) return "Cloudflare is limiting hostname changes. Try again in a few minutes.";
  if (status === 504) return "Cloudflare did not answer in time. Try again later.";
  if (status === 401 || status === 403 || status === 503) {
    return "Doxa cannot manage custom hostnames right now. Try again later.";
  }
  return GENERIC_PROVISIONING_MESSAGE;
}

function createCustomHostnamesClient(env: Env): {
  client: CloudflareCustomHostnamesClient | null;
  configurationError: DocsDomainProvisioningError | null;
} {
  try {
    return {
      client: createCloudflareCustomHostnamesClient({
        apiToken: env.CLOUDFLARE_API_TOKEN,
        zoneId: env.CLOUDFLARE_ZONE_ID,
        sslMethod: env.CLOUDFLARE_CUSTOM_HOSTNAME_SSL_METHOD,
        minTlsVersion: env.CLOUDFLARE_CUSTOM_HOSTNAME_MIN_TLS_VERSION,
      }),
      configurationError: null,
    };
  } catch (err) {
    return {
      client: null,
      configurationError: toDocsDomainProvisioningError(err),
    };
  }
}

function createMissingCloudflareConfigError(): DocsDomainProvisioningError {
  return new DocsDomainProvisioningError(
    "Cloudflare custom hostname provisioning is not configured for this environment.",
    503,
  );
}

function normalizeOptionalHostname(hostname: string | undefined): string | null {
  const normalizedHostname = hostname?.trim().toLowerCase().replace(/\.$/, "");
  return normalizedHostname ? normalizedHostname : null;
}
