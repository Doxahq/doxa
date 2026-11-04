import type { TryBudget } from "./budget";

export interface TryProxyEnv {
  TRY_CLIENT: RateLimit;
  TRY_SITE: RateLimit;
  TRY_TARGET: RateLimit;
  TRY_BUDGET: DurableObjectNamespace<TryBudget>;
  TRY_METRICS?: AnalyticsEngineDataset;
  /** The kill switch: `off`, `allowlist` or `all`. Anything else is `off`. */
  DOXA_PROD_TRY_PROXY_MODE?: string;
  DOXA_PROD_TRY_PROXY_SITE_IDS?: string;
  /** Comma-separated hosts. A host blocks its subdomains too. */
  DOXA_TRY_BLOCKED_HOSTS?: string;
  DOXA_TRY_RESERVED_ZONES?: string;
  DOXA_TRY_SITE_DAILY_LIMIT?: string;
  DOXA_TRY_TARGET_DAILY_LIMIT?: string;
}
