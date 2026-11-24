import { eq } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";

type DocsNamespaceTransaction = Parameters<
  Parameters<DoxaDb["transaction"]>[0]
>[0];

export type DocsNamespaceDatabase = DoxaDb | DocsNamespaceTransaction;

export interface DocsNamespaceCandidate {
  label: string;
  hostname: string | null;
}

export interface DocsNamespaceLookup {
  hasProjectSlug(slug: string): Promise<boolean>;
  hasSiteSlug(slug: string): Promise<boolean>;
  hasPreviewHostname(hostname: string): Promise<boolean>;
  hasCustomHostname(hostname: string): Promise<boolean>;
}

/**
 * Site names that no project can take (Decision 2). Every other name is first
 * come, first served. A reserved name gets the same number suffix as a taken
 * one, for example `docs-2`.
 */
export const RESERVED_SITE_LABELS: ReadonlySet<string> = new Set([
  "doxa",
  "docs",
  "api",
  "www",
  "admin",
]);

export function isReservedSiteLabel(label: string): boolean {
  return RESERVED_SITE_LABELS.has(label.trim().toLowerCase());
}

export async function isHostnameAvailable(
  lookup: DocsNamespaceLookup,
  candidate: DocsNamespaceCandidate,
): Promise<boolean> {
  if (isReservedSiteLabel(candidate.label)) return false;
  if (await lookup.hasProjectSlug(candidate.label)) return false;
  if (await lookup.hasSiteSlug(candidate.label)) return false;

  if (!candidate.hostname) return true;
  if (await lookup.hasPreviewHostname(candidate.hostname)) return false;
  return !(await lookup.hasCustomHostname(candidate.hostname));
}

export function createDocsNamespaceLookup(
  db: DocsNamespaceDatabase,
): DocsNamespaceLookup {
  return {
    async hasProjectSlug(slug) {
      const [row] = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.slug, slug))
        .limit(1);
      return Boolean(row);
    },
    async hasSiteSlug(slug) {
      const [row] = await db
        .select({ id: schema.docsSites.id })
        .from(schema.docsSites)
        .where(eq(schema.docsSites.slug, slug))
        .limit(1);
      return Boolean(row);
    },
    async hasPreviewHostname(hostname) {
      const [row] = await db
        .select({ id: schema.docsPreviewChannels.id })
        .from(schema.docsPreviewChannels)
        .where(eq(schema.docsPreviewChannels.hostname, hostname))
        .limit(1);
      return Boolean(row);
    },
    async hasCustomHostname(hostname) {
      const [row] = await db
        .select({ id: schema.docsDomains.id })
        .from(schema.docsDomains)
        .where(eq(schema.docsDomains.hostname, hostname))
        .limit(1);
      return Boolean(row);
    },
  };
}
