import { clientIpRateLimitKey } from "@doxahq/contracts/client-ip";
import type { EdgeEnv } from "./env";

/**
 * Per-IP limits on public api.doxa.so requests (SEC-008), checked before the
 * request reaches the origin. Each class has its own Workers Rate Limiting
 * namespace, so an IP spends one budget per class.
 *
 * - client registration: each call stores an OAuth client in Valkey;
 * - the other OAuth endpoints: each authorize call stores a consent and can
 *   fetch a client metadata URL;
 * - agent registration: each call stores a claim, and needs no credential;
 * - everything else: a ceiling for one IP that the dashboard never reaches.
 */
export type EdgeRateLimitEnv = Pick<
  EdgeEnv,
  "API_OAUTH_REGISTER_LIMITER" | "API_OAUTH_LIMITER" | "API_AGENT_IDENTITY_LIMITER" | "API_PUBLIC_LIMITER"
>;

const OAUTH_REGISTER_PATH = "/oauth/register";
const AGENT_IDENTITY_PATH = "/agent/identity";
/**
 * The doxa.so web Worker calls GET /me while it renders the login, consent,
 * invite and approve pages. Those calls all come from Cloudflare's egress IP,
 * so a per-IP budget would let one client block the pages for everyone. A /me
 * call is a cheap session read.
 */
const SHARED_EGRESS_PATHS = new Set(["/me"]);
/**
 * GitHub sends every webhook from a few shared IPs. The route checks the
 * HMAC over a bounded body, so a forged delivery costs little.
 */
const UNCOUNTED_PATHS = new Set(["/github/webhook"]);

export function limiterForRequest(
  request: Request,
  env: EdgeRateLimitEnv,
): RateLimit | undefined {
  const path = new URL(request.url).pathname.replace(/\/+$/, "").toLowerCase();
  // A CORS preflight is answered at once; counting it would halve the budget.
  if (request.method === "OPTIONS" || UNCOUNTED_PATHS.has(path)) return undefined;
  if (path === OAUTH_REGISTER_PATH) return env.API_OAUTH_REGISTER_LIMITER;
  if (path === AGENT_IDENTITY_PATH) return env.API_AGENT_IDENTITY_LIMITER;
  if (path.startsWith("/oauth/")) return env.API_OAUTH_LIMITER;
  if (request.method === "GET" && SHARED_EGRESS_PATHS.has(path)) return undefined;
  return env.API_PUBLIC_LIMITER;
}

/** A 429 response when the client IP is over its limit, else null. */
export async function limitPublicRequest(
  request: Request,
  env: EdgeRateLimitEnv,
): Promise<Response | null> {
  const limiter = limiterForRequest(request, env);
  const clientIp = request.headers.get("cf-connecting-ip");
  if (!limiter || !clientIp) return null;

  const { success } = await limiter.limit({ key: clientIpRateLimitKey(clientIp) });
  if (success) return null;

  return Response.json(
    { error: { message: "Too many requests. Try again in a minute." } },
    {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    },
  );
}
