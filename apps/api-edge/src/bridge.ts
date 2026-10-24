import {
  BRIDGE_CALL_PATH_PREFIX,
  BRIDGE_FETCH_PATH_PREFIX,
  BRIDGE_KEY_HEADER,
  EDGE_ONLY_HEADERS,
  FORWARD_URL_HEADER,
  isBridgeCallBindingName,
  isBridgeCallMethod,
  isBridgeFetchBindingName,
  parseCallPath,
  secretsMatch,
  serveRemoteCall,
} from "@doxahq/api-bridge";
import type { EdgeEnv } from "./env";

/**
 * Serves the origin's calls on Cloudflare bindings:
 *
 *   POST /__bridge/call/:binding/:method   a Queue or RPC binding method
 *   ANY  /__bridge/fetch/:binding          a fetch binding (the agent container)
 *
 * Only listed bindings and methods run, and only with the bridge key.
 */
export function serveBridge(request: Request, env: EdgeEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(BRIDGE_CALL_PATH_PREFIX)) return serveBridgeCall(request, env, pathname);
  if (pathname.startsWith(BRIDGE_FETCH_PATH_PREFIX)) return serveBridgeFetch(request, env, pathname);
  return Promise.resolve(notFound());
}

async function serveBridgeCall(request: Request, env: EdgeEnv, pathname: string): Promise<Response> {
  const call = parseCallPath(pathname, BRIDGE_CALL_PATH_PREFIX);
  if (!call || !isBridgeCallBindingName(call.target) || !isBridgeCallMethod(call.target, call.method)) {
    return notFound();
  }
  const bindingName = call.target;
  const method = call.method;

  return serveRemoteCall(request, { keyHeader: BRIDGE_KEY_HEADER, key: env.BRIDGE_SHARED_SECRET }, (args) => {
    const binding: unknown = env[bindingName];
    if (typeof binding !== "object" || binding === null) {
      throw new Error(`The edge Worker has no ${bindingName} binding.`);
    }
    const target: unknown = Reflect.get(binding, method);
    if (typeof target !== "function") throw new Error(`${bindingName}.${method} is not a method.`);
    return Reflect.apply(target, binding, args);
  });
}

async function serveBridgeFetch(request: Request, env: EdgeEnv, pathname: string): Promise<Response> {
  const bindingName = pathname.slice(BRIDGE_FETCH_PATH_PREFIX.length);
  if (!isBridgeFetchBindingName(bindingName)) return notFound();
  if (!secretsMatch(request.headers.get(BRIDGE_KEY_HEADER), env.BRIDGE_SHARED_SECRET)) {
    return new Response("Unauthorized.", { status: 401 });
  }
  const forwardUrl = URL.parse(request.headers.get(FORWARD_URL_HEADER) ?? "");
  if (!forwardUrl) return new Response(`The ${FORWARD_URL_HEADER} header must hold an absolute URL.`, { status: 400 });

  const binding = env[bindingName];
  if (!binding) return new Response(`The edge Worker has no ${bindingName} binding.`, { status: 503 });

  const headers = new Headers(request.headers);
  for (const name of EDGE_ONLY_HEADERS) headers.delete(name);
  // Built from the original request, so the method and the streamed body carry over.
  return binding.fetch(new Request(new Request(forwardUrl, request), { headers }));
}

function notFound(): Response {
  return new Response("Not found.", { status: 404 });
}
