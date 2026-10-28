import { z } from "zod";
import type { DocsHostnameMapRpc } from "./docs-hostname-map";

/**
 * How long the docs dispatcher keeps a resolved hostname (hostname → site and
 * published version). A publish, a domain change and a project deletion purge
 * the entry, so the lifetime matters only when a purge loses a race with a
 * lookup that started before the change. Storage that a cached hostname can
 * still point to must outlive it: see `HOSTNAME_READER_GRACE_SECONDS`.
 */
export const DOCS_HOSTNAME_CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long a retired version folder or a deleted site's storage must stay
 * readable: the hostname cache lifetime plus one hour for renders in flight.
 */
export const HOSTNAME_READER_GRACE_SECONDS =
  DOCS_HOSTNAME_CACHE_TTL_SECONDS + 60 * 60;

export const docsCacheInvalidationSchema = z.object({
  siteId: z.string().min(1).max(128),
  hostname: z.string().min(1).max(253).optional(),
});

export type DocsCacheInvalidation = z.infer<typeof docsCacheInvalidationSchema>;

/**
 * Private service binding only (`doxa-docs-renderer#DocsHostCache`). A
 * resolved call means the purge, or the hostname map write, was accepted.
 */
export interface DocsCacheInvalidationRpc extends DocsHostnameMapRpc {
  invalidate(input: DocsCacheInvalidation): Promise<void>;
}
