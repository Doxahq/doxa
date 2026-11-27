import { CRON_PATH, ORIGIN_KEY_HEADER, RELEASE_HEADER, callRemote, rpcPath } from "@doxahq/api-bridge";
import type { EdgeEnv } from "./env";

/** Where the edge sends a request for the origin, and how. */
export interface Origin {
  /** The origin URL with this path and query. */
  url(pathname: string, search?: string): string;
  fetch(request: Request): Promise<Response>;
}

/**
 * Base URL of requests through an origin binding. The VPC Service decides
 * the target (the API port on 127.0.0.1 in the task) and ignores this host
 * and port. The scheme must be http: the service has only an HTTP port. The
 * tunnel encrypts the traffic up to the task.
 */
export const VPC_ORIGIN_BASE_URL = "http://doxa-api-origin";

/** URL.hostname keeps the brackets of an IPv6 address. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The binding of each origin color. */
const COLOR_BINDINGS = { blue: "ORIGIN_BLUE", green: "ORIGIN_GREEN" } as const;

type OriginColor = keyof typeof COLOR_BINDINGS;

/**
 * The origin of this Worker. Production binds both colors of the origin,
 * each a Workers VPC Service of a private tunnel, so no request to the
 * origin crosses the public internet, and ORIGIN_COLOR picks one.
 * Development sets ORIGIN_URL to the local Node server. Any other setup
 * throws, so the origin key never goes to another host.
 */
export function resolveOrigin(env: EdgeEnv): Origin {
  const binding = liveColorBinding(env);
  if (binding) {
    if (env.ORIGIN_URL !== undefined) {
      throw new Error("The edge Worker has origin bindings and ORIGIN_URL. Production uses only the bindings.");
    }
    return createOrigin(VPC_ORIGIN_BASE_URL, (request) => binding.fetch(request), env.DOXA_RELEASE_ID);
  }
  if (env.ORIGIN_URL !== undefined) {
    return createOrigin(loopbackOrigin(env.ORIGIN_URL), (request) => fetch(request), env.DOXA_RELEASE_ID);
  }
  throw new Error("The edge Worker has no origin. Bind ORIGIN_BLUE and ORIGIN_GREEN in production, or set ORIGIN_URL in development.");
}

/** The binding that ORIGIN_COLOR names, or undefined without origin bindings (development). */
function liveColorBinding(env: EdgeEnv): Fetcher | undefined {
  if (!env.ORIGIN_BLUE && !env.ORIGIN_GREEN) return undefined;
  const color = env.ORIGIN_COLOR;
  if (!isOriginColor(color)) {
    throw new Error(`ORIGIN_COLOR must be blue or green, not ${JSON.stringify(color)}. The release sets it (scripts/deploy/deploy-api.mjs).`);
  }
  const binding = env[COLOR_BINDINGS[color]];
  if (!binding) throw new Error(`ORIGIN_COLOR names ${color}, but the edge Worker has no ${COLOR_BINDINGS[color]} binding.`);
  return binding;
}

function isOriginColor(value: string | undefined): value is OriginColor {
  return value !== undefined && Object.hasOwn(COLOR_BINDINGS, value);
}

/** ORIGIN_URL as an origin (scheme, host and port), if it is an http(s) URL on this machine. */
function loopbackOrigin(value: string): string {
  const url = URL.parse(value);
  const isLoopback =
    url !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTNAMES.has(url.hostname) &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!isLoopback) {
    throw new Error(`ORIGIN_URL must be a loopback URL without a path, for example http://localhost:8786. It is "${value}".`);
  }
  return url.origin;
}

function createOrigin(baseUrl: string, send: (request: Request) => Promise<Response>, releaseId: string | undefined): Origin {
  return {
    // Sets the path on the parsed base instead of resolving it against the
    // base: `new URL("//evil.example/x", base)` resolves to another host.
    url(pathname, search = "") {
      const url = new URL(baseUrl);
      url.pathname = pathname;
      url.search = search;
      return url.toString();
    },
    // Every request names the edge release, so the origin can log a mix of releases.
    fetch: releaseId ? (request) => send(withHeader(request, RELEASE_HEADER, releaseId)) : send,
  };
}

/** A copy of the request with one more header. The body moves to the copy. */
function withHeader(request: Request, name: string, value: string): Request {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return new Request(request, { headers });
}

/** One RPC call on the origin, as the caller Worker made it on this Worker. */
export function callOrigin(env: EdgeEnv, entrypoint: string, method: string, args: readonly unknown[]): Promise<unknown> {
  const origin = resolveOrigin(env);
  return callRemote(
    {
      fetch: origin.fetch,
      url: origin.url(rpcPath(entrypoint, method)),
      keyHeader: ORIGIN_KEY_HEADER,
      key: env.ORIGIN_SHARED_SECRET,
    },
    args,
  );
}

/** Tells the origin to run the jobs of one cron tick. The origin answers 202 and runs them itself. */
export async function sendCronTick(env: EdgeEnv, scheduledTime: number): Promise<void> {
  const origin = resolveOrigin(env);
  const response = await origin.fetch(
    new Request(origin.url(CRON_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", [ORIGIN_KEY_HEADER]: env.ORIGIN_SHARED_SECRET },
      body: JSON.stringify({ scheduledTime }),
      // Never follow a redirect with the origin key: a 3xx fails the tick below.
      redirect: "manual",
    }),
  );
  if (response.status !== 202) {
    throw new Error(`The origin refused the cron tick with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}
