import { z } from "zod";
import type { DocsHostnameMapSync } from "./docs-hostname-map";

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

/** Private service binding only. A resolved call means the purge was accepted. */
export interface DocsCacheInvalidationRpc {
  invalidate(input: DocsCacheInvalidation): Promise<void>;
  /**
   * Writes the hostname map (see `./docs-hostname-map`). Optional in the
   * type only so that test doubles can leave it out; the deployed dispatcher
   * has it.
   */
  syncHostnames?(input: DocsHostnameMapSync): Promise<void>;
}
