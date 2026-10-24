import { isGenerationPreviewHostname } from "./generation-preview-host";

type AccessPolicy = "public" | "authenticated";
type RuntimeEnv = Record<string, string | undefined>;
type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

interface PolicyCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface AccessGateDependencies {
  fetcher?: Fetcher;
  policyCache?: PolicyCache | null;
}

interface AccessGateConfig {
  apiBaseUrl: string;
  dashboardBaseUrl: string;
}

declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}

const AUTHENTICATED_POLICY: AccessPolicy = "authenticated";

export async function getAccessGateResponse(
  request: Request,
  env: RuntimeEnv = process.env,
  dependencies: AccessGateDependencies = {}
): Promise<Response | null> {
  const hostname = new URL(request.url).hostname;
  const docsBaseDomain = readRuntimeEnv(env, "DOXA_DOCS_BASE_DOMAIN");
  if (!isGenerationPreviewHostname(hostname, docsBaseDomain)) return null;

  const config = readAccessGateConfig(env);
  if (!config) {
    return new Response("Preview access is unavailable.", { status: 503 });
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const policyCache =
    dependencies.policyCache === undefined
      ? getDefaultPolicyCache()
      : dependencies.policyCache;
  const policy = await getAccessPolicy(
    hostname,
    config.apiBaseUrl,
    fetcher,
    policyCache
  );
  if (policy === "public") return null;

  // Revision 1 checks sign-in only. It does not check project ownership.
  const signedIn = await hasDoxaSession(request, config.apiBaseUrl, fetcher);
  if (signedIn) return null;

  const loginUrl = new URL("/login", config.dashboardBaseUrl);
  loginUrl.searchParams.set("redirect", request.url);
  return Response.redirect(loginUrl, 302);
}

function readAccessGateConfig(env: RuntimeEnv): AccessGateConfig | null {
  const apiBaseUrl = readHttpOrigin(env, "DOXA_API_BASE_URL");
  const dashboardBaseUrl = readHttpOrigin(env, "DOXA_DASHBOARD_BASE_URL");
  if (!apiBaseUrl || !dashboardBaseUrl) return null;

  return { apiBaseUrl, dashboardBaseUrl };
}

async function getAccessPolicy(
  hostname: string,
  apiBaseUrl: string,
  fetcher: Fetcher,
  policyCache: PolicyCache | null
): Promise<AccessPolicy> {
  const policyRequest = new Request(
    `${apiBaseUrl}/internal/docs-access/${encodeURIComponent(hostname)}`
  );
  const cachedResponse = await readCachedResponse(policyCache, policyRequest);
  if (cachedResponse) return parseAccessPolicy(cachedResponse);

  try {
    const response = await fetcher(policyRequest);
    if (!response.ok) return AUTHENTICATED_POLICY;

    const cacheResponse = response.clone();
    const policy = await parseAccessPolicy(response);
    await writeCachedResponse(policyCache, policyRequest, cacheResponse);
    return policy;
  } catch {
    return AUTHENTICATED_POLICY;
  }
}

async function hasDoxaSession(
  request: Request,
  apiBaseUrl: string,
  fetcher: Fetcher
): Promise<boolean> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;

  try {
    const response = await fetcher(`${apiBaseUrl}/api/auth/get-session`, {
      headers: { cookie },
    });
    if (!response.ok) return false;

    const body: unknown = await response.json();
    return hasUser(body);
  } catch {
    return false;
  }
}

async function parseAccessPolicy(response: Response): Promise<AccessPolicy> {
  try {
    const body: unknown = await response.json();
    if (
      isRecord(body) &&
      (body.policy === "public" || body.policy === "authenticated")
    ) {
      return body.policy;
    }
  } catch {
    return AUTHENTICATED_POLICY;
  }

  return AUTHENTICATED_POLICY;
}

function hasUser(value: unknown): boolean {
  return isRecord(value) && isRecord(value.user);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRuntimeEnv(env: RuntimeEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function readHttpOrigin(env: RuntimeEnv, name: string): string | null {
  const value = readRuntimeEnv(env, name);
  if (!value) return null;

  try {
    const url = new URL(value);
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    if (
      !isHttp ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function getDefaultPolicyCache(): PolicyCache | null {
  return typeof caches === "undefined" ? null : caches.default;
}

async function readCachedResponse(
  cache: PolicyCache | null,
  request: Request
): Promise<Response | null> {
  if (!cache) return null;
  try {
    return (await cache.match(request)) ?? null;
  } catch {
    return null;
  }
}

async function writeCachedResponse(
  cache: PolicyCache | null,
  request: Request,
  response: Response
): Promise<void> {
  if (!cache) return;
  await cache.put(request, response).catch(() => undefined);
}
