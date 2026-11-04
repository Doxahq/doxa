import {
  CLIENT_COUNTRY_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_REGION_HEADER,
  CRON_PATH,
  EDGE_ONLY_HEADERS,
  ORIGIN_KEY_HEADER,
  PUBLIC_URL_HEADER,
  RPC_PATH_PREFIX,
  secretsMatch,
} from "@doxahq/api-bridge";
import { isWarmPool } from "@doxahq/contracts/docs-warm-region";
import type { Env } from "../../env";
import type { ScopedFetch } from "../../http/request-scope";

/** The only request served without the origin key: the container health check. */
const HEALTH_PATH = "/health";

/** Headers that a client can set and that would claim a client IP. The edge sends the real one. */
const CLIENT_IP_CLAIMS = ["cf-connecting-ip", "cf-ipcountry", "x-real-ip", "x-forwarded-for"] as const;

export interface OriginHandlerDeps {
  env: Env;
  originKey: string;
  /** The public API, as the Worker serves it. */
  api: ScopedFetch;
  rpc: (request: Request) => Promise<Response>;
  cron: (request: Request) => Promise<Response>;
  createExecutionContext(): ExecutionContext;
}

/**
 * Every request to the Node server. Only the edge Worker knows the origin
 * key, so a request without it gets 401, except `GET /health`, which the
 * container health check calls on localhost. That one gets a fixed answer
 * here and never reaches the API, so its headers cannot steer a request.
 *
 * A public request continues to the API as the client sent it to the edge:
 * with the public URL (https://api.doxa.so/…, not the tunnel hostname), the
 * client IP and country under the header names that Better Auth reads, and
 * the client's cache pool under `CLIENT_REGION_HEADER` (see `client-region.ts`).
 */
export function createOriginHandler(deps: OriginHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (!secretsMatch(request.headers.get(ORIGIN_KEY_HEADER), deps.originKey)) {
      if (request.method === "GET" && pathname === HEALTH_PATH) return Response.json({ ok: true, service: "doxa-api" });
      return new Response("Unauthorized.", { status: 401 });
    }

    if (pathname.startsWith(RPC_PATH_PREFIX)) return deps.rpc(request);
    if (pathname === CRON_PATH) return deps.cron(request);

    return deps.api(asPublicRequest(request), deps.env, deps.createExecutionContext());
  };
}

/**
 * The request as the API expects it: the public URL, client headers as
 * Cloudflare names them, edge headers gone. Only the cache pool keeps its
 * edge header name, re-set here from the keyed request's value when it names
 * a known pool, so the API can trust it.
 */
export function asPublicRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  const url = publicUrlOf(headers.get(PUBLIC_URL_HEADER)) ?? request.url;
  const clientIp = headers.get(CLIENT_IP_HEADER);
  const country = headers.get(CLIENT_COUNTRY_HEADER);
  const region = headers.get(CLIENT_REGION_HEADER);
  for (const name of [...EDGE_ONLY_HEADERS, ...CLIENT_IP_CLAIMS]) headers.delete(name);
  if (clientIp) headers.set("cf-connecting-ip", clientIp);
  if (country) headers.set("cf-ipcountry", country);
  if (isWarmPool(region)) headers.set(CLIENT_REGION_HEADER, region);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: request.redirect,
    signal: request.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  });
}

function publicUrlOf(value: string | null): string | null {
  if (!value) return null;
  const url = URL.parse(value);
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : null;
}
