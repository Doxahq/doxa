/** The bindings and variables of the thin doxa-api Worker. */
export interface EdgeEnv {
  /**
   * The two Node origins (blue/green ECS services), each through the Workers
   * VPC Service of its own private tunnel. Production only: the origin has
   * no public hostname. ORIGIN_COLOR names the one that gets the traffic.
   */
  ORIGIN_BLUE?: Fetcher;
  ORIGIN_GREEN?: Fetcher;
  /** "blue" or "green". The release sets it on each edge version (scripts/deploy/deploy-api.mjs). */
  ORIGIN_COLOR?: string;
  /**
   * Development only: the local Node origin, for example http://localhost:8786.
   * It must be a loopback URL. Never set it next to the origin bindings.
   */
  ORIGIN_URL?: string;
  /** The release of this edge version, sent to the origin in RELEASE_HEADER. */
  DOXA_RELEASE_ID?: string;
  /** Sent with every request to the origin. */
  ORIGIN_SHARED_SECRET: string;
  /** Expected on every bridge request from the origin. */
  BRIDGE_SHARED_SECRET: string;

  // Bindings that the origin uses through the bridge.
  GENERATION_QUEUE: Queue<unknown>;
  EMAIL_QUEUE?: Queue<unknown>;
  DOCS_CACHE_INVALIDATOR?: Service;
  PRERENDER_QUEUE?: Service;
  AGENT_CONTAINER?: Fetcher;

  // Per-IP rate limits of public requests (see ./rate-limit).
  API_OAUTH_REGISTER_LIMITER?: RateLimit;
  API_OAUTH_LIMITER?: RateLimit;
  API_AGENT_IDENTITY_LIMITER?: RateLimit;
  API_PUBLIC_LIMITER?: RateLimit;
}
