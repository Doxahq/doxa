import { CRON_PATH, ORIGIN_KEY_HEADER, callRemote, rpcPath } from "@doxahq/api-bridge";
import type { EdgeEnv } from "./env";

/** Where the edge sends a request for the origin, and how. */
export interface Origin {
  /** The origin URL with this path and query. */
  url(pathname: string, search?: string): string;
  fetch(request: Request): Promise<Response>;
}

/**
 * Base URL of requests through the ORIGIN binding. The VPC Service decides
 * the target (the API port on 127.0.0.1 in the task) and ignores this host
 * and port. The scheme must be http: the service has only an HTTP port. The
 * tunnel encrypts the traffic up to the task.
 */
export const VPC_ORIGIN_BASE_URL = "http://doxa-api-origin";

/** URL.hostname keeps the brackets of an IPv6 address. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin of this Worker. Production binds ORIGIN, the Workers VPC
 * Service of the private tunnel, so no request to the origin crosses the
 * public internet. Development sets ORIGIN_URL to the local Node server.
 * Any other setup throws, so the origin key never goes to another host.
 */
export function resolveOrigin(env: EdgeEnv): Origin {
  if (env.ORIGIN) {
    if (env.ORIGIN_URL !== undefined) {
      throw new Error("The edge Worker has both ORIGIN and ORIGIN_URL. Production uses only the ORIGIN binding.");
    }
    const binding = env.ORIGIN;
    return createOrigin(VPC_ORIGIN_BASE_URL, (request) => binding.fetch(request));
  }
  if (env.ORIGIN_URL !== undefined) {
    return createOrigin(loopbackOrigin(env.ORIGIN_URL), (request) => fetch(request));
  }
  throw new Error("The edge Worker has no origin. Bind ORIGIN in production, or set ORIGIN_URL in development.");
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

function createOrigin(baseUrl: string, send: (request: Request) => Promise<Response>): Origin {
  return {
    // Sets the path on the parsed base instead of resolving it against the
    // base: `new URL("//evil.example/x", base)` resolves to another host.
    url(pathname, search = "") {
      const url = new URL(baseUrl);
      url.pathname = pathname;
      url.search = search;
      return url.toString();
    },
    fetch: send,
  };
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
