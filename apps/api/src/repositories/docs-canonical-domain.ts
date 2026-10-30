import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { schema } from "@doxahq/db";
import type {
  DocsDomainRoutingStatus,
  DocsDomainStatus,
  DocsDomainVerificationStatus,
} from "@doxahq/contracts";

/**
 * A site with a canonical custom domain has one public address: its
 * `doxa.page` hostname redirects there, so it serves no pages and needs no
 * pre-render. A custom domain is canonical when it is active, verified, and
 * its last routing check reached Doxa: a redirect to a domain whose DNS does
 * not point here would take the site down. This module holds the rule once,
 * in SQL and in TypeScript.
 */

/** SQL: the custom domain rows of `siteId` that the rule accepts. */
export function canonicalCustomDomainCondition(siteId: AnyColumn | string): SQL {
  return and(
    eq(schema.docsDomains.siteId, siteId),
    eq(schema.docsDomains.kind, "custom_domain"),
    eq(schema.docsDomains.status, "active"),
    eq(schema.docsDomains.verificationStatus, "verified"),
    eq(schema.docsDomains.routingStatus, "healthy"),
  )!;
}

/** SQL: whether the site's `doxa.page` hostname redirects to a custom domain. */
export function siteRedirectsToCustomDomain(siteId: AnyColumn): SQL {
  return sql`exists (select 1 from ${schema.docsDomains} where ${canonicalCustomDomainCondition(siteId)})`;
}

/** The same rule for one domain row, to detect a change of it. */
export function isCanonicalCustomDomain(domain: {
  kind: "doxa_subdomain" | "custom_domain";
  status: DocsDomainStatus;
  verificationStatus: DocsDomainVerificationStatus;
  routingStatus: DocsDomainRoutingStatus;
}): boolean {
  return (
    domain.kind === "custom_domain" &&
    domain.status === "active" &&
    domain.verificationStatus === "verified" &&
    domain.routingStatus === "healthy"
  );
}
