/**
 * The HTTP protocol between the thin `doxa-api` Worker (the edge) and the
 * Node API server (the origin).
 *
 *   edge → origin   every request carries the origin key
 *     /__rpc/:entrypoint/:method   an RPC call that a caller Worker made
 *     /__cron                      the 5-minute cron tick
 *     anything else                a public request, proxied as it is
 *
 *   origin → edge   every request carries the bridge key
 *     /__bridge/call/:binding/:method   a call on a Queue or RPC binding
 *     /__bridge/fetch/:binding          a fetch on a fetch binding
 *
 * The edge never proxies a public request to a path under `/__`, so only the
 * edge itself can reach the RPC and cron routes.
 */

/** Paths under this prefix are internal on both sides. */
export const INTERNAL_PATH_PREFIX = "/__";

export const RPC_PATH_PREFIX = "/__rpc/";
export const CRON_PATH = "/__cron";
export const BRIDGE_CALL_PATH_PREFIX = "/__bridge/call/";
export const BRIDGE_FETCH_PATH_PREFIX = "/__bridge/fetch/";

/** The edge → origin key. The edge sends it with every request. */
export const ORIGIN_KEY_HEADER = "x-doxa-origin-key";
/** The origin → edge key. The origin sends it with every bridge request. */
export const BRIDGE_KEY_HEADER = "x-doxa-bridge-key";
/** The client IP and country as Cloudflare saw them, set by the edge. */
export const CLIENT_IP_HEADER = "x-doxa-client-ip";
export const CLIENT_COUNTRY_HEADER = "x-doxa-client-country";
/** The URL that a bridged fetch goes to inside the fetch binding. */
export const FORWARD_URL_HEADER = "x-doxa-forward-url";
/** The URL that the client called at the edge, for example https://api.doxa.so/me. */
export const PUBLIC_URL_HEADER = "x-doxa-public-url";

/** Headers that only the edge may set. The edge drops them from public requests. */
export const EDGE_ONLY_HEADERS = [
  ORIGIN_KEY_HEADER,
  BRIDGE_KEY_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_COUNTRY_HEADER,
  FORWARD_URL_HEADER,
  PUBLIC_URL_HEADER,
] as const;

export const CODEC_CONTENT_TYPE = "application/x-doxa-devalue";

/**
 * The RPC entrypoints of the API and their methods. The edge exposes these
 * classes with the same names, so the caller Workers keep their bindings.
 * A test in apps/api checks this list against the entrypoint classes.
 */
export const API_ENTRYPOINT_METHODS = {
  InternalApi: [
    "resolveDocsSite",
    "resolveDocsProject",
    "resolveDocsHost",
    "readDocsArtifact",
    "getGenerationContext",
    "getGenerationExecutionContext",
    "getCurrentChangeProposalState",
    "createInstallationAccessToken",
    "markJobRunning",
    "markJobFailed",
    "markJobCancelled",
    "markJobSuperseded",
    "isJobActive",
    "getGenerationResumedAt",
    "getGenerationControl",
    "listStaleGenerationJobs",
    "addJobEvent",
    "getGenerationDatabaseCompatibility",
    "recordGenerationUsage",
    "recordGenerationDiagnostic",
    "getGenerationUsageSummary",
    "deleteExpiredGenerationObservability",
    "publishJobOutput",
    "completeJobOutput",
    "createReviewRun",
    "updateReviewRun",
  ],
  PrerenderTaskApi: ["validate", "heartbeat", "complete", "fail", "enqueueRepair"],
  OAuthTokenValidator: ["validateToken"],
  AgentActionsApi: ["perform", "getRequest", "getRequestTask", "listRequests", "cancelRequest"],
  EmailDeliveryApi: ["claimEmailDelivery", "recordEmailAttempt"],
} as const;

export type ApiEntrypointName = keyof typeof API_ENTRYPOINT_METHODS;
export type ApiEntrypointMethod<E extends ApiEntrypointName> = (typeof API_ENTRYPOINT_METHODS)[E][number];

/**
 * The edge bindings that the origin calls through the bridge, and the
 * methods it may call on each. Anything else is refused.
 */
export const BRIDGE_CALL_BINDINGS = {
  GENERATION_QUEUE: ["send", "sendBatch"],
  EMAIL_QUEUE: ["send", "sendBatch"],
  DOCS_CACHE_INVALIDATOR: ["invalidate"],
  PRERENDER_QUEUE: ["start", "inspect", "collectRender"],
} as const;

export type BridgeCallBindingName = keyof typeof BRIDGE_CALL_BINDINGS;
export type BridgeCallMethod<B extends BridgeCallBindingName> = (typeof BRIDGE_CALL_BINDINGS)[B][number];

/** Edge bindings that the origin reaches with a plain fetch through the bridge. */
export const BRIDGE_FETCH_BINDINGS = ["AGENT_CONTAINER"] as const;

export type BridgeFetchBindingName = (typeof BRIDGE_FETCH_BINDINGS)[number];

export function isApiEntrypointName(name: string): name is ApiEntrypointName {
  return Object.hasOwn(API_ENTRYPOINT_METHODS, name);
}

export function isApiEntrypointMethod<E extends ApiEntrypointName>(
  entrypoint: E,
  method: string,
): method is ApiEntrypointMethod<E> {
  return (API_ENTRYPOINT_METHODS[entrypoint] as readonly string[]).includes(method);
}

export function isBridgeCallBindingName(name: string): name is BridgeCallBindingName {
  return Object.hasOwn(BRIDGE_CALL_BINDINGS, name);
}

export function isBridgeCallMethod<B extends BridgeCallBindingName>(
  binding: B,
  method: string,
): method is BridgeCallMethod<B> {
  return (BRIDGE_CALL_BINDINGS[binding] as readonly string[]).includes(method);
}

export function isBridgeFetchBindingName(name: string): name is BridgeFetchBindingName {
  return (BRIDGE_FETCH_BINDINGS as readonly string[]).includes(name);
}

/** `/__rpc/InternalApi/addJobEvent` → `{ target: "InternalApi", method: "addJobEvent" }`. */
export function parseCallPath(pathname: string, prefix: string): { target: string; method: string } | null {
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { target: parts[0], method: parts[1] };
}

export function rpcPath(entrypoint: string, method: string): string {
  return `${RPC_PATH_PREFIX}${entrypoint}/${method}`;
}

export function bridgeCallPath(binding: string, method: string): string {
  return `${BRIDGE_CALL_PATH_PREFIX}${binding}/${method}`;
}

export function bridgeFetchPath(binding: string): string {
  return `${BRIDGE_FETCH_PATH_PREFIX}${binding}`;
}
