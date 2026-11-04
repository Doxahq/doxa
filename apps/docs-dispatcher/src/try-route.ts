import type {
  DocsDomainResolution,
} from "@doxahq/contracts";
import { clientIpRateLimitKey } from "@doxahq/contracts/client-ip";
import {
  DOCS_TRY_CONFIG_PATH,
  DOCS_TRY_CONTENT_TYPE,
  DOCS_TRY_PATH,
  DOCS_TRY_PROBLEM_CONTENT_TYPE,
  type DocsTryConfig,
  type DocsTryContext,
  type DocsTryProblem,
  type DocsTryProxyRpc,
} from "@doxahq/contracts/docs-try";

import { toHostResolution } from "./host-resolution";
import { requestDocsRuntime } from "./runtime-trace";
import type { DocsRuntimeRpc } from "./worker-exports";

export function isDocsTryRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === DOCS_TRY_PATH || pathname === DOCS_TRY_CONFIG_PATH;
}

interface DocsTryRouteDependencies {
  resolveHost(hostname: string): Promise<DocsDomainResolution | null>;
  runtime: Pick<DocsRuntimeRpc, "request">;
  /** Absent means that the proxy is not provisioned: the browser sends. */
  proxy: DocsTryProxyRpc | undefined;
}

interface PlaygroundSettings {
  baseUrl: string;
  transport: "proxy" | "browser" | undefined;
}

/**
 * The public side of "Try it". It runs before the renderer, and it never reads
 * the request body, so a reader's key cannot reach dispatcher logs.
 *
 * SECURITY REGRESSION GUARDRAIL (SEC-010): the target comes only from the
 * owner's setting for the resolved site. No value in the request can change it.
 */
export async function handleDocsTryRequest(
  request: Request,
  dependencies: DocsTryRouteDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const isConfig = url.pathname === DOCS_TRY_CONFIG_PATH;

  const allowed = isConfig ? "GET" : "POST";
  if (request.method !== allowed) {
    return new Response(null, {
      status: 405,
      headers: { allow: allowed, "cache-control": "no-store" },
    });
  }
  if (!isSameOriginCall(request, url, isConfig)) {
    return problem(403, "not_same_origin", "This request did not come from this docs site.");
  }
  if (!isConfig && !hasTryContentType(request)) {
    return problem(415, "unsupported_media_type", "This request has the wrong content type.");
  }

  const resolution = await dependencies.resolveHost(url.hostname);
  if (!resolution) return isConfig ? configAnswer({ mode: "off" }) : tryOff();

  const settings = await readPlaygroundSettings(dependencies.runtime, resolution);
  if (!settings) return isConfig ? configAnswer({ mode: "off" }) : tryOff();

  const browserReason = readBrowserReason(settings, resolution, url.hostname);
  if (browserReason) {
    return isConfig
      ? configAnswer({ mode: "browser", reason: browserReason })
      : tryOff();
  }
  if (!dependencies.proxy) {
    return isConfig
      ? configAnswer({ mode: "browser", reason: "proxy_off" })
      : tryOff();
  }

  const context: DocsTryContext = {
    siteId: resolution.siteId,
    baseUrl: settings.baseUrl,
    clientKey: clientIpRateLimitKey(request.headers.get("cf-connecting-ip") ?? "unknown"),
  };
  return isConfig
    ? configAnswer(await dependencies.proxy.config(context))
    : dependencies.proxy.send(request.body, context);
}

/**
 * `doxa.page` is not on the Public Suffix List, so two tenants count as
 * `same-site`. The check must be `same-origin`. A script can forge these
 * headers, so they stop other sites in a reader's browser, not scripts. The
 * rate limits handle scripts.
 */
function isSameOriginCall(request: Request, url: URL, isConfig: boolean): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  return isConfig || request.headers.get("origin") === url.origin;
}

function hasTryContentType(request: Request): boolean {
  const value = request.headers.get("content-type") ?? "";
  return value.split(";", 1)[0]?.trim().toLowerCase() === DOCS_TRY_CONTENT_TYPE;
}

async function readPlaygroundSettings(
  runtime: Pick<DocsRuntimeRpc, "request">,
  resolution: DocsDomainResolution,
): Promise<PlaygroundSettings | null> {
  const answer = await requestDocsRuntime(
    runtime,
    { resolution: toHostResolution(resolution), operation: "getFeatureConfig" },
    "content",
  );
  if (!answer.ok || typeof answer.data !== "object" || answer.data === null) return null;
  const { apiPlayground, apiPlaygroundBaseUrl, apiPlaygroundTransport } = answer.data as Record<
    string,
    unknown
  >;
  if (apiPlayground !== true || typeof apiPlaygroundBaseUrl !== "string") return null;
  if (!apiPlaygroundBaseUrl) return null;
  return {
    baseUrl: apiPlaygroundBaseUrl,
    transport:
      apiPlaygroundTransport === "proxy" || apiPlaygroundTransport === "browser"
        ? apiPlaygroundTransport
        : undefined,
  };
}

function readBrowserReason(
  settings: PlaygroundSettings,
  resolution: DocsDomainResolution,
  docsHost: string,
): Extract<DocsTryConfig, { mode: "browser" }>["reason"] | null {
  // Version 1 keeps private docs out of the proxy: their access gate runs in
  // the renderer, after this route.
  if (resolution.accessPolicy !== "public") return "private_site";
  if (settings.transport === "browser") return "owner_choice";
  if (settings.baseUrl.startsWith("/")) return "same_origin";
  if (URL.canParse(settings.baseUrl) && new URL(settings.baseUrl).hostname === docsHost) {
    return "same_origin";
  }
  return null;
}

function configAnswer(config: DocsTryConfig): Response {
  return Response.json(config, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function tryOff(): Response {
  return problem(403, "try_off", "This site does not send requests through Doxa.");
}

function problem(status: number, code: DocsTryProblem["code"], title: string): Response {
  const body: DocsTryProblem = { code, title };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": DOCS_TRY_PROBLEM_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
