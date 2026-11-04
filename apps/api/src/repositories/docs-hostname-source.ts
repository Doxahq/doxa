import { and, eq, isNotNull } from "drizzle-orm";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import type { DocsDomainResolution } from "@doxahq/contracts";

import {
  resolveDocsHost,
  type DocsResolutionEnv,
} from "../services/docs-host-resolution";
import type { DocsHostnameSource } from "../services/docs-hostname-map";
import { createGeneratedDocsHostname } from "../utils/docs-url";

/**
 * Reads hostnames and their resolutions with the resolver's own rules. It
 * connects on first use, so constructing it opens no connection.
 */
export class DocsHostnameSourceRepository implements DocsHostnameSource {
  constructor(
    private readonly env: DocsResolutionEnv,
    private connection?: DoxaDb,
  ) {}

  private get db(): DoxaDb {
    this.connection ??= createDb(this.env);
    return this.connection;
  }

  resolve(hostname: string): Promise<DocsDomainResolution | null> {
    return resolveDocsHost(this.env, hostname);
  }

  async listSiteHostnames(siteId: string): Promise<string[]> {
    const [site] = await this.db
      .select({ slug: schema.docsSites.slug })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.id, siteId))
      .limit(1);
    const domains = await this.db
      .select({ hostname: schema.docsDomains.hostname })
      .from(schema.docsDomains)
      .where(eq(schema.docsDomains.siteId, siteId));
    return [
      ...(site ? this.generatedHostnames([site]) : []),
      ...domains.map(({ hostname }) => hostname),
    ];
  }

  async listPublicHostnames(): Promise<string[]> {
    const sites = await this.db
      .select({ slug: schema.docsSites.slug })
      .from(schema.docsSites)
      .where(isNotNull(schema.docsSites.publishedVersionId));
    const domains = await this.db
      .select({ hostname: schema.docsDomains.hostname })
      .from(schema.docsDomains)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsDomains.siteId, schema.docsSites.id),
      )
      .where(
        and(
          eq(schema.docsDomains.status, "active"),
          eq(schema.docsDomains.verificationStatus, "verified"),
          isNotNull(schema.docsSites.publishedVersionId),
        ),
      );
    return [
      ...this.generatedHostnames(sites),
      ...domains.map(({ hostname }) => hostname),
    ];
  }

  private generatedHostnames(sites: ReadonlyArray<{ slug: string }>): string[] {
    return sites.flatMap(({ slug }) => {
      const hostname = createGeneratedDocsHostname(
        slug,
        this.env.DOCS_BASE_DOMAIN,
      );
      return hostname ? [hostname] : [];
    });
  }
}
