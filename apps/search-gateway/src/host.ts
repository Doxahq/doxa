import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  docsHostnameMapKey,
  readHostnameMapEntry,
} from "@doxahq/contracts/docs-hostname-map";
import { DocsResolverClient } from "@doxahq/contracts/docs-resolver";

import type { SearchGatewayEnv } from "./env";

/**
 * Finds the live version of a hostname with the dispatcher's sources: the
 * hostname map first, then the resolver. A publish rewrites the map, so a new
 * version reaches the gateway when it reaches the dispatcher.
 */
export async function resolveSearchHost(
  env: Pick<SearchGatewayEnv, "DOCS_HOSTNAME_MAP" | "DOCS_RESOLVER">,
  hostname: string,
  now: number,
): Promise<DocsDomainResolution | null> {
  const mapped = await readMappedHost(env.DOCS_HOSTNAME_MAP, hostname, now);
  if (mapped) return mapped;
  return new DocsResolverClient(env.DOCS_RESOLVER).resolveDocsHost(hostname);
}

async function readMappedHost(
  store: KVNamespace | undefined,
  hostname: string,
  now: number,
): Promise<DocsDomainResolution | null> {
  if (!store) return null;
  try {
    const raw = await store.get(docsHostnameMapKey(hostname));
    if (!raw) return null;
    const entry = readHostnameMapEntry(JSON.parse(raw), hostname, now);
    return entry.status === "hit" ? entry.resolution : null;
  } catch {
    return null;
  }
}
