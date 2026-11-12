import type { DocsDomainDnsHost } from "@doxahq/contracts";
import type { Env } from "../env";
import { DocsDomainsRepository } from "../repositories/docs-domains";
import {
  createDnsHostDetector,
  UNKNOWN_DNS_HOST,
  type DnsHostDetector,
} from "./dns-host-detection";

interface DocsDomainDnsHostReader {
  getForProject: DocsDomainsRepository["getForProject"];
}

interface DocsDomainDnsHostDependencies {
  domains?: DocsDomainDnsHostReader;
  detector?: DnsHostDetector;
}

/**
 * The DNS host of one custom docs domain, so the dashboard can show setup
 * steps for that provider. Read only: it never changes the domain or its
 * custom hostname.
 */
export class DocsDomainDnsHostService {
  private readonly domains: DocsDomainDnsHostReader;
  private readonly detector: DnsHostDetector;

  constructor(env: Env, dependencies: DocsDomainDnsHostDependencies = {}) {
    this.domains = dependencies.domains ?? new DocsDomainsRepository(env);
    this.detector = dependencies.detector ?? createDnsHostDetector();
  }

  /** Null when the domain is not in the project. A Doxa subdomain has no DNS host to detect. */
  async detectForProject(input: {
    userId: string;
    projectId: string;
    domainId: string;
  }): Promise<DocsDomainDnsHost | null> {
    const domain = await this.domains.getForProject(input);
    if (!domain) return null;
    if (domain.kind !== "custom_domain") return UNKNOWN_DNS_HOST;
    return this.detector.detect(domain.hostname);
  }
}
