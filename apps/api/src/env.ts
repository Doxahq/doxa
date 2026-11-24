import type { AuthEnv } from "@doxahq/auth";
import type { DocsCacheInvalidationRpc, GenerateJobMessage } from "@doxahq/contracts";
import type { AgentContainerBinding, GenerationMode } from "@doxahq/generation";
import type { PrerenderQueueRpc } from "@doxahq/contracts/docs-prerender-tasks";
import type { EmailQueueMessage } from "@doxahq/email";
import type { ModelTokenBroker } from "./services/model-access/model-token-broker";
import type { ImageCompressor } from "./services/site-assets/image-compression";
import type { SvgCleaner } from "./services/site-assets/image-content";
import type { BillingPaymentsBinding } from "./services/billing/payments-port";

export interface Env extends AuthEnv {
  DOCS_CACHE_INVALIDATOR?: DocsCacheInvalidationRpc;
  PRERENDER_QUEUE?: PrerenderQueueRpc;
  DOCS_BUCKET: R2Bucket;
  GENERATION_QUEUE: Queue<GenerateJobMessage>;
  /** Producer for the `doxa-email` Worker. Optional so that Workers without email still start. */
  EMAIL_QUEUE?: Queue<EmailQueueMessage>;
  /** Account of Cloudflare Email Service, for the hourly suppression sync. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Secret: an API token with read access to Email Sending suppressions. */
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
  AGENT_CONTAINER?: AgentContainerBinding;
  /**
   * Mints short-lived Anthropic tokens for generations. Only the Node origin
   * has it, from its AWS role; elsewhere generations use the static key.
   */
  MODEL_TOKEN_BROKER?: ModelTokenBroker;
  /**
   * Compresses uploaded images. The Node origin has the encoder, and
   * `doxa-mcp` reaches it over RPC. Without it, uploads store the original.
   */
  IMAGE_COMPRESSOR?: ImageCompressor;
  /** Only the Node origin has it. Elsewhere the Worker's CPU limit bounds a parse. */
  SVG_CLEANER?: SvgCleaner;
  DATABASE_URL?: string;
  /** The search cluster. Without both, every site stays on browser search. */
  SEARCH_TYPESENSE_HOST?: string;
  /** Scoped to `s_*` collections. It never leaves the API. */
  SEARCH_TYPESENSE_WRITE_KEY?: string;
  /** Project IDs on a paid search plan, until billing stores the plan. */
  DOXA_PROD_SEARCH_PAID_PROJECT_IDS?: string;
  /** Rolls gateway usage into `docs_search_usage_daily`. */
  SEARCH_USAGE_ACCOUNT_ID?: string;
  SEARCH_USAGE_API_TOKEN?: string;
  GENERATION_MODE?: GenerationMode;
  AGENT_CONTAINER_URL?: string;
  OPENROUTER_API_KEY?: string;
  DOXA_AGENT_MODEL?: string;
  DOXA_PLANNER_MODEL?: string;
  DOXA_WRITER_MODEL?: string;
  /**
   * Billing spec 10.5: the agent worker's model provider and fallback writer,
   * so credit admission refuses a run with an unpriced model. Set them to the
   * worker's values. Defaults: `anthropic`, and the planner model.
   */
  DOXA_MODEL_PROVIDER?: string;
  DOXA_WRITER_FALLBACK_MODEL?: string;
  DOXA_GENERATION_PROFILE?: "fast-mvp" | "full-prod";
  DOXABOT_ENABLED?: string;
  DOXABOT_PUBLIC_REPOSITORIES_ENABLED?: string;
  DOXABOT_GENERATOR_FINGERPRINT?: string;
  /** The largest repository a generation accepts, in KB (GitHub's `size`). Default 1048576 (1 GB). */
  MAX_REPOSITORY_SIZE_KB?: string;
  DOXA_AGENT_PAGE_CONCURRENCY?: string;
  GENERATION_TIMEOUT_MS?: string;
  GENERATION_IDLE_TIMEOUT_MS?: string;
  GENERATION_OVERALL_TIMEOUT_MS?: string;
  ANALYSIS_STAGE_TIMEOUT_MS?: string;
  STRUCTURE_STAGE_TIMEOUT_MS?: string;
  PAGE_BATCH_TIMEOUT_MS?: string;
  FINALIZATION_TIMEOUT_MS?: string;
  GENERATION_STREAM_POLL_INTERVAL_MS?: string;
  GENERATION_STREAM_HEARTBEAT_MS?: string;
  GENERATION_STREAM_TERMINAL_GRACE_MS?: string;
  GENERATION_STREAM_MAX_DURATION_MS?: string;
  ALLOW_INTERNAL_HTTP?: string;
  LOCAL_DEV_USER_ID?: string;
  LOCAL_GITHUB_TOKEN?: string;
  WEB_ORIGIN?: string;
  DOCS_RUNTIME_URL?: string;
  DOCS_BASE_DOMAIN?: string;
  /**
   * The project of the official Doxa docs. Only this project can connect
   * `docs.doxa.so`, the one exact host of the retired base domains.
   */
  DOXA_OFFICIAL_DOCS_PROJECT_ID?: string;
  DOCS_RENDERER_BASE_URL?: string;
  DOCS_PREVIEW_GATE_ENABLED?: string;
  DOCS_CUSTOM_DOMAIN_CNAME_TARGET?: string;
  DOXA_RENDERER_RELEASE_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_CUSTOM_HOSTNAME_SSL_METHOD?: string;
  CLOUDFLARE_CUSTOM_HOSTNAME_MIN_TLS_VERSION?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  DOXA_RUNTIME_ENVIRONMENT?: "development" | "production";
  ALLOW_INSECURE_GITHUB_WEBHOOKS?: string;
  ADMIN_EMAILS?: string;
  DEV_ADMIN_ENABLED?: string;
  /**
   * "true" adds a Server-Timing header to every response. Platform admins get
   * the header without it.
   */
  DEBUG?: string;
  /** Storage of the OAuth authorization server: clients, grants, tokens, pending consents. */
  OAUTH_KV?: KVNamespace;
  /**
   * The OpenStatus heartbeat URL of the 5-minute cron. Its token is the only
   * credential, so it is a secret (SSM on the Node origin). Unset: no ping.
   */
  OPENSTATUS_CRON_HEARTBEAT_URL?: string;
  OAUTH_ISSUER?: string;
  /** Opens the auth.md agent signup flow. Only the exact value `true` opens it. */
  AGENT_SIGNUP_ENABLED?: string;
  /** Only the exact value `true` opens the live agent activity panel. */
  AGENT_LIVE_ACTIVITY_ENABLED?: string;
  MCP_RESOURCE_URL?: string;
  /** Billing spec 6.3: `stripe`, `none` or `memory`. Default `none` (plan `self_hosted`). */
  BILLING_PROVIDER?: string;
  /** `off` (default), `shadow` (log each denial, allow) or `on` (deny). */
  BILLING_ENFORCEMENT?: string;
  /** A plan key. Default `free` with a provider, `self_hosted` with `none`. */
  BILLING_DEFAULT_PLAN?: string;
  /** The origin of Checkout and Portal return URLs. Default `WEB_ORIGIN`. */
  BILLING_RETURN_BASE_URL?: string;
  /** Secret, Stripe provider only. Never in this repo or a Wrangler file. */
  STRIPE_SECRET_KEY?: string;
  /** Secret, Stripe provider only. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** `on` or `off` (default). */
  STRIPE_MANAGED_PAYMENTS?: string;
  /**
   * Checkout, Portal, invoices, webhooks and the billing jobs. Only the Node
   * origin has it: `@doxahq/billing/payments` stays out of Worker builds.
   */
  BILLING_PAYMENTS?: BillingPaymentsBinding;
}

export function isDocsPreviewGateEnabled(value: string | undefined): boolean {
  return value === "true";
}
