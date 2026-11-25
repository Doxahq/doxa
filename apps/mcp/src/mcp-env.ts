import type { AuthorizationServerBinding } from "@cloudflare/workers-oauth-provider";
import type { AnalyticsEnv } from "@doxahq/analytics";
import type { AgentGrantProps } from "@doxahq/contracts/agent-access";
import type { HyperdriveBinding } from "@doxahq/db";
import type { AgentActionsRpc } from "@doxahq/api/services/agent-actions/rpc-contract";

/**
 * Bindings of the `doxa-mcp` Worker. It holds no secrets (spec 5.2): no queue
 * producer, no cache invalidator, no Cloudflare or GitHub credentials. The
 * PostHog project key (`POSTHOG_KEY`) is public by design: it can only send.
 */
export interface McpEnv extends AnalyticsEnv {
  AUTH_SERVER: AuthorizationServerBinding<AgentGrantProps>;
  /** The `AgentActionsApi` entrypoint of doxa-api: every consequential action runs there. */
  PLATFORM_ACTIONS?: AgentActionsRpc;
  HYPERDRIVE?: HyperdriveBinding;
  HYPERDRIVE_CACHE_DISABLED?: HyperdriveBinding;
  DATABASE_URL?: string;
  DOCS_BUCKET: R2Bucket;
  MCP_READ_LIMITER: RateLimit;
  MCP_WRITE_LIMITER: RateLimit;
  MCP_EXPENSIVE_LIMITER: RateLimit;
  /**
   * Per client IP, before the bearer token is checked (SEC-008): a flood of
   * random tokens must not reach token validation without a limit. The limit
   * is high (6000 a minute): hosted MCP clients share a few egress IPs.
   */
  MCP_IP_LIMITER?: RateLimit;
  MCP_RESOURCE_URL: string;
  OAUTH_ISSUER: string;
  WEB_ORIGIN?: string;
  DOCS_BASE_DOMAIN?: string;
  DOCS_RENDERER_BASE_URL?: string;
  /** Lets `list_domains` show the CNAME record a custom domain needs. */
  DOCS_CUSTOM_DOMAIN_CNAME_TARGET?: string;
  /** Only the exact value `true` records live agent activity. */
  AGENT_LIVE_ACTIVITY_ENABLED?: string;
  /** Local development only. The production config must never set it. */
  MCP_DEV_AUTH_BYPASS?: string;
  /**
   * Billing settings for the plan checks that the API services run in this
   * Worker: entitlements, limits, and the daily tool-call quota. They read the
   * billing tables only, so this Worker needs no payment provider: production
   * sets `BILLING_PROVIDER=none` and names the default plan, which must match
   * the API's. Unset, enforcement is `off` and every project gets the free
   * plan stubs.
   */
  BILLING_PROVIDER?: string;
  BILLING_ENFORCEMENT?: string;
  BILLING_DEFAULT_PLAN?: string;
}
