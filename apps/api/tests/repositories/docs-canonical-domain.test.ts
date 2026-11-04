import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@doxahq/db";
import { describe, expect, test } from "vitest";

import {
  canonicalCustomDomainCondition,
  isCanonicalCustomDomain,
  siteRedirectsToCustomDomain,
} from "../../src/repositories/docs-canonical-domain";
import { createObsoletePrerenderTaskCondition } from "../../src/repositories/docs-prerender-tasks";

const canonical = {
  kind: "custom_domain",
  status: "active",
  verificationStatus: "verified",
  routingStatus: "healthy",
} as const;

describe("canonical custom domain rule", () => {
  test("accepts only an active, verified custom domain whose routing reached Doxa", () => {
    expect(isCanonicalCustomDomain(canonical)).toBe(true);
    expect(isCanonicalCustomDomain({ ...canonical, kind: "doxa_subdomain" })).toBe(false);
    expect(isCanonicalCustomDomain({ ...canonical, status: "disabled" })).toBe(false);
    expect(isCanonicalCustomDomain({ ...canonical, verificationStatus: "pending" })).toBe(false);
    expect(isCanonicalCustomDomain({ ...canonical, routingStatus: "failed" })).toBe(false);
    expect(isCanonicalCustomDomain({ ...canonical, routingStatus: "pending" })).toBe(false);
  });

  test("holds the same five conditions in SQL", () => {
    const query = new PgDialect().sqlToQuery(canonicalCustomDomainCondition("site-1"));

    for (const column of ["site_id", "kind", "status", "verification_status", "routing_status"]) {
      expect(query.sql).toContain(`"docs_domains"."${column}" = $`);
    }
    expect(query.params).toEqual(["site-1", "custom_domain", "active", "verified", "healthy"]);
  });

  test("checks a site by its column inside a subquery", () => {
    const query = new PgDialect().sqlToQuery(siteRedirectsToCustomDomain(schema.docsSites.id));

    expect(query.sql).toContain('exists (select 1 from "docs_domains" where');
    expect(query.sql).toContain('"docs_domains"."site_id" = "docs_sites"."id"');
  });

  test("makes a pre-render task of a redirecting doxa.page hostname obsolete", () => {
    const query = new PgDialect().sqlToQuery(
      createObsoletePrerenderTaskCondition({
        docsBaseDomain: "doxa.page",
        rendererReleaseId: "b".repeat(64),
        accessPolicy: "public",
      }).getSQL(),
    );

    expect(query.sql).toContain('and not exists (select 1 from "docs_domains"');
    expect(query.params).toContain("healthy");
  });
});
