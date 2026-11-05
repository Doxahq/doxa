import { and, asc, count, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import { readDocsSearchTarget } from "../services/docs-search/site-provider";
import type {
  DocsDomainDto,
  DocsDomainProvider,
  DocsDomainResolution,
  DocsDomainSslValidationRecord,
  DocsDomainStatus,
  DocsDomainVerificationStatus,
} from "@doxahq/contracts";
import type { Env } from "../env";
import { resolveDocsAccessPolicy } from "../services/docs-access";
import type { DocsDomainRoutingState } from "../services/docs-domain-routing";
import { normalizeDocsHostname } from "../utils/hostname";
import {
  withDocsCacheInvalidation,
  withDocsPublicationEffects,
} from "./docs-cache-mutation";
import {
  canonicalCustomDomainCondition,
  isCanonicalCustomDomain,
} from "./docs-canonical-domain";

export const RETIRED_DOCS_BASE_DOMAINS = ["docs.doxa.so"] as const;

export type CreateCustomDocsDomainErrorCode =
  | "invalid_hostname"
  | "reserved_hostname"
  | "project_not_found"
  | "project_domain_limit_reached"
  | "hostname_taken";

export class CreateCustomDocsDomainError extends Error {
  constructor(readonly code: CreateCustomDocsDomainErrorCode) {
    super(getCreateCustomDocsDomainMessage(code));
  }
}

export interface DocsDomainProvisioningState {
  provider: DocsDomainProvider;
  providerHostnameId: string;
  providerStatus: string | null;
  providerSslStatus: string | null;
  verificationStatus: DocsDomainVerificationStatus;
  ownershipVerification: {
    type: string | null;
    name: string | null;
    value: string | null;
  } | null;
  ownershipVerificationHttp: {
    url: string | null;
    body: string | null;
  } | null;
  sslValidationRecords: DocsDomainSslValidationRecord[];
  verificationError: string | null;
}

export class DocsDomainsRepository {
  private readonly db;

  constructor(
    private readonly env: Pick<
      Env,
      | "DATABASE_URL"
      | "HYPERDRIVE"
      | "HYPERDRIVE_CACHE_DISABLED"
      | "DOCS_CACHE_INVALIDATOR"
      | "DOCS_BASE_DOMAIN"
      | "DOXA_RENDERER_RELEASE_ID"
      | "PRERENDER_QUEUE"
    >,
  ) {
    this.db = createDb(env);
  }

  async listForProject(input: {
    userId: string;
    projectId: string;
  }): Promise<DocsDomainDto[] | null> {
    const site = await this.getOwnedSite(input);
    if (!site) return null;

    const rows = await this.db
      .select()
      .from(schema.docsDomains)
      .where(eq(schema.docsDomains.projectId, site.projectId))
      .orderBy(asc(schema.docsDomains.createdAt));

    return rows.map(toDocsDomainDto);
  }

  async createCustomDomain(input: {
    userId: string;
    projectId: string;
    hostname: string;
    docsBaseDomain?: string;
    customDomainLimit: number;
  }): Promise<DocsDomainDto> {
    const normalizedHostname = validateCustomDocsHostname({
      hostname: input.hostname,
      docsBaseDomain: input.docsBaseDomain,
    });

    const site = await this.getOwnedSite({
      userId: input.userId,
      projectId: input.projectId,
    });
    if (!site) {
      throw new CreateCustomDocsDomainError("project_not_found");
    }

    return withDocsCacheInvalidation(
      this.db,
      this.env,
      async (transaction, enqueue) => {
        const [lockedProject] = await transaction
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.id, site.projectId))
          .for("update")
          .limit(1);
        if (!lockedProject) {
          throw new CreateCustomDocsDomainError("project_not_found");
        }

        const [customDomainCount] = await transaction
          .select({ value: count() })
          .from(schema.docsDomains)
          .where(
            and(
              eq(schema.docsDomains.projectId, site.projectId),
              eq(schema.docsDomains.kind, "custom_domain"),
            ),
          );
        if (customDomainCount.value >= input.customDomainLimit) {
          throw new CreateCustomDocsDomainError("project_domain_limit_reached");
        }

        const [existingHostname] = await transaction
          .select({ id: schema.docsDomains.id })
          .from(schema.docsDomains)
          .where(eq(schema.docsDomains.hostname, normalizedHostname))
          .limit(1);
        if (existingHostname) {
          throw new CreateCustomDocsDomainError("hostname_taken");
        }

        const [domain] = await transaction
          .insert(schema.docsDomains)
          .values({
            projectId: site.projectId,
            siteId: site.siteId,
            hostname: normalizedHostname,
            kind: "custom_domain",
            status: "disabled",
            verificationStatus: "pending",
          })
          .returning();

        await enqueue({ siteId: site.siteId, hostname: normalizedHostname });
        return toDocsDomainDto(domain);
      },
    );
  }

  async listPreferredCustomHostnames(projectIds: string[]): Promise<Map<string, string>> {
    if (projectIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        projectId: schema.docsDomains.projectId,
        hostname: schema.docsDomains.hostname,
      })
      .from(schema.docsDomains)
      .where(
        and(
          inArray(schema.docsDomains.projectId, projectIds),
          eq(schema.docsDomains.kind, "custom_domain"),
          eq(schema.docsDomains.status, "active"),
          eq(schema.docsDomains.verificationStatus, "verified"),
        ),
      )
      .orderBy(asc(schema.docsDomains.createdAt), asc(schema.docsDomains.id));

    const hostnames = new Map<string, string>();
    for (const row of rows) {
      if (!hostnames.has(row.projectId)) {
        hostnames.set(row.projectId, row.hostname);
      }
    }
    return hostnames;
  }

  async getForProject(input: {
    userId: string;
    projectId: string;
    domainId: string;
  }): Promise<DocsDomainDto | null> {
    const site = await this.getOwnedSite(input);
    if (!site) return null;

    const [domain] = await this.db
      .select()
      .from(schema.docsDomains)
      .where(
        and(
          eq(schema.docsDomains.id, input.domainId),
          eq(schema.docsDomains.projectId, site.projectId),
        ),
      )
      .limit(1);

    return domain ? toDocsDomainDto(domain) : null;
  }

  async applyProvisioning(input: {
    userId: string;
    projectId: string;
    domainId: string;
    status: DocsDomainStatus;
    provisioning: DocsDomainProvisioningState;
    routing: DocsDomainRoutingState;
  }): Promise<DocsDomainDto | null> {
    const site = await this.getOwnedSite(input);
    if (!site) return null;

    return withDocsPublicationEffects(
      this.db,
      this.env,
      async (tx, enqueue, enqueuePrerender) => {
        const [previous] = await tx
          .select()
          .from(schema.docsDomains)
          .where(
            and(
              eq(schema.docsDomains.id, input.domainId),
              eq(schema.docsDomains.projectId, site.projectId),
            ),
          )
          .for("update")
          .limit(1);
        if (!previous) return null;

        const [domain] = await tx
          .update(schema.docsDomains)
          .set({
            status: input.status,
            verificationStatus: input.provisioning.verificationStatus,
            provider: input.provisioning.provider,
            providerHostnameId: input.provisioning.providerHostnameId,
            providerStatus: input.provisioning.providerStatus,
            providerSslStatus: input.provisioning.providerSslStatus,
            ownershipVerificationType:
              input.provisioning.ownershipVerification?.type ?? null,
            ownershipVerificationName:
              input.provisioning.ownershipVerification?.name ?? null,
            ownershipVerificationValue:
              input.provisioning.ownershipVerification?.value ?? null,
            ownershipVerificationHttpUrl:
              input.provisioning.ownershipVerificationHttp?.url ?? null,
            ownershipVerificationHttpBody:
              input.provisioning.ownershipVerificationHttp?.body ?? null,
            sslValidationRecords: input.provisioning.sslValidationRecords,
            verificationError: input.provisioning.verificationError,
            routingStatus: input.routing.status,
            routingHttpStatus: input.routing.httpStatus,
            routingError: input.routing.error,
            routingCheckedAt: input.routing.checkedAt,
            lastCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.docsDomains.id, input.domainId),
              eq(schema.docsDomains.projectId, site.projectId),
            ),
          )
          .returning();

        // A task resyncs every hostname of the site, so the `doxa.page`
        // hostname starts or stops redirecting to this domain too.
        if (
          domain &&
          (isRoutableDomain(previous) !== isRoutableDomain(domain) ||
            isCanonicalCustomDomain(previous) !== isCanonicalCustomDomain(domain))
        ) {
          await enqueue({ siteId: domain.siteId, hostname: domain.hostname });
          if (isRoutableDomain(domain) && site.publishedVersionId) {
            await enqueuePrerender({
              siteId: domain.siteId,
              publishedVersionId: site.publishedVersionId,
              hostname: domain.hostname,
              reason: "hostname_activation",
            });
          }
        }
        return domain ? toDocsDomainDto(domain) : null;
      },
    );
  }

  async deleteForProject(input: {
    userId: string;
    projectId: string;
    domainId: string;
  }): Promise<boolean> {
    const site = await this.getOwnedSite(input);
    if (!site) return false;

    return withDocsCacheInvalidation(
      this.db,
      this.env,
      async (tx, enqueue) => {
        const [domain] = await tx
          .delete(schema.docsDomains)
          .where(
            and(
              eq(schema.docsDomains.id, input.domainId),
              eq(schema.docsDomains.projectId, site.projectId),
            ),
          )
          .returning({
            siteId: schema.docsDomains.siteId,
            hostname: schema.docsDomains.hostname,
          });

        if (domain)
          await enqueue({ siteId: domain.siteId, hostname: domain.hostname });
        return Boolean(domain);
      },
    );
  }

  /**
   * The custom domain that the site's `doxa.page` hostname redirects to: the
   * oldest one that `canonicalCustomDomainCondition` accepts. Null while the site has
   * none, so the `doxa.page` hostname serves the site itself.
   */
  async findCanonicalHostname(siteId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ hostname: schema.docsDomains.hostname })
      .from(schema.docsDomains)
      .where(canonicalCustomDomainCondition(siteId))
      .orderBy(asc(schema.docsDomains.createdAt), asc(schema.docsDomains.id))
      .limit(1);
    return row?.hostname ?? null;
  }

  async resolveByHostname(
    hostname: string,
  ): Promise<DocsDomainResolution | null> {
    const normalizedHostname = normalizeDocsHostname(hostname);
    if (!normalizedHostname) return null;

    const [row] = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsSites.publishedVersionId,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
        hostname: schema.docsDomains.hostname,
        domainKind: schema.docsDomains.kind,
        searchProvider: schema.docsSites.searchProvider,
        searchIndexKey: schema.docsSites.searchIndexKey,
      })
      .from(schema.docsDomains)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsDomains.siteId, schema.docsSites.id),
      )
      .innerJoin(
        schema.docsVersions,
        eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
      )
      .where(
        and(
          eq(schema.docsDomains.hostname, normalizedHostname),
          eq(schema.docsDomains.status, "active"),
          eq(schema.docsDomains.verificationStatus, "verified"),
        ),
      )
      .limit(1);

    if (!row?.publishedVersionId) return null;
    return {
      siteId: row.siteId,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      publishedVersionId: row.publishedVersionId,
      artifactPrefix: row.artifactPrefix,
      manifestPath: row.manifestPath,
      accessPolicy: resolveDocsAccessPolicy({
        isGenerationPreview: false,
        previewVisibility: "private",
        gateEnabled: false,
      }),
      ...readDocsSearchTarget(row),
      hostname: row.hostname,
      domainKind: row.domainKind,
    };
  }

  private async getOwnedSite(input: { userId: string; projectId: string }) {
    const [site] = await this.db
      .select({
        projectId: schema.projects.id,
        siteId: schema.docsSites.id,
        publishedVersionId: schema.docsSites.publishedVersionId,
      })
      .from(schema.projects)
      .innerJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.userId, input.userId),
        ),
      )
      .limit(1);

    return site ?? null;
  }
}

function isRoutableDomain(domain: {
  status: DocsDomainStatus;
  verificationStatus: DocsDomainVerificationStatus;
}): boolean {
  return domain.status === "active" && domain.verificationStatus === "verified";
}



function toDocsDomainDto(
  domain: typeof schema.docsDomains.$inferSelect,
): DocsDomainDto {
  return {
    id: domain.id,
    projectId: domain.projectId,
    siteId: domain.siteId,
    hostname: domain.hostname,
    kind: domain.kind,
    status: domain.status,
    verificationStatus: domain.verificationStatus,
    provider: toDocsDomainProvider(domain.provider),
    providerHostnameId: domain.providerHostnameId,
    providerStatus: domain.providerStatus,
    providerSslStatus: domain.providerSslStatus,
    ownershipVerification:
      domain.ownershipVerificationName || domain.ownershipVerificationValue
        ? {
            type: domain.ownershipVerificationType,
            name: domain.ownershipVerificationName,
            value: domain.ownershipVerificationValue,
          }
        : null,
    ownershipVerificationHttp:
      domain.ownershipVerificationHttpUrl ||
      domain.ownershipVerificationHttpBody
        ? {
            url: domain.ownershipVerificationHttpUrl,
            body: domain.ownershipVerificationHttpBody,
          }
        : null,
    sslValidationRecords: domain.sslValidationRecords ?? [],
    dnsRecord: null,
    verificationError: domain.verificationError,
    routingStatus: domain.routingStatus,
    routingHttpStatus: domain.routingHttpStatus,
    routingError: domain.routingError,
    routingCheckedAt: domain.routingCheckedAt?.toISOString() ?? null,
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
  };
}

function toDocsDomainProvider(
  provider: string | null,
): DocsDomainProvider | null {
  return provider === "cloudflare" ? provider : null;
}

function isPublicCustomHostname(hostname: string): boolean {
  return hostname.includes(".") && hostname !== "localhost";
}

export function isHostnameWithinBaseDomain(
  hostname: string,
  baseDomain: string,
): boolean {
  return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
}

export function validateCustomDocsHostname(input: {
  hostname: string;
  docsBaseDomain?: string;
}): string {
  const normalizedHostname = normalizeDocsHostname(input.hostname);
  if (!normalizedHostname || !isPublicCustomHostname(normalizedHostname)) {
    throw new CreateCustomDocsDomainError("invalid_hostname");
  }

  const activeBaseDomain = input.docsBaseDomain
    ? normalizeDocsHostname(input.docsBaseDomain)
    : null;
  const reservedBaseDomains = [
    activeBaseDomain,
    ...RETIRED_DOCS_BASE_DOMAINS,
  ].filter((baseDomain): baseDomain is string => Boolean(baseDomain));

  if (
    reservedBaseDomains.some((baseDomain) =>
      isHostnameWithinBaseDomain(normalizedHostname, baseDomain),
    )
  ) {
    throw new CreateCustomDocsDomainError("reserved_hostname");
  }

  return normalizedHostname;
}

function getCreateCustomDocsDomainMessage(
  code: CreateCustomDocsDomainErrorCode,
): string {
  switch (code) {
    case "invalid_hostname":
      return "Enter a valid public hostname.";
    case "reserved_hostname":
      return "This hostname is reserved for Doxa-managed docs domains.";
    case "project_not_found":
      return "Project not found.";
    case "project_domain_limit_reached":
      return "This project has reached its custom domain limit.";
    case "hostname_taken":
      return "This hostname is already connected to another docs project.";
  }
}
