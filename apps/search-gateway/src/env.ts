import type { DocsResolverBinding } from "@doxahq/contracts/docs-resolver";

export interface SearchGatewayEnv {
  DOCS_RESOLVER: DocsResolverBinding;
  /** Read only. The API writes the map. */
  DOCS_HOSTNAME_MAP?: KVNamespace;
  SEARCH_CLIENT?: RateLimit;
  SEARCH_SITE?: RateLimit;
  SEARCH_USAGE?: AnalyticsEngineDataset;
  /** Off by default: `on` lets the gateway answer searches. */
  DOXA_PROD_SEARCH_GATEWAY_MODE?: string;
  /** The search cluster. The key can only search `s_*` collections. */
  SEARCH_TYPESENSE_HOST?: string;
  SEARCH_TYPESENSE_SEARCH_KEY?: string;
  /** Local development only: allows `http://` page origins. */
  SEARCH_ALLOW_HTTP_ORIGINS?: string;
}
