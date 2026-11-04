import {
  DOCS_TRY_LIMITS,
  docsTryTargetBaseUrl,
  isHostInZone,
  parseDocsTryTarget,
  type DocsTryConfig,
  type DocsTryContext,
  type DocsTryProblemCode,
  type DocsTryTarget,
} from "@doxahq/contracts/docs-try";

import type { TryProxyEnv } from "./env";
import { applyTryLimits } from "./limits";
import { readTryRequest } from "./request-schema";
import { buildTargetHeaders, buildTargetUrl } from "./target-request";
import {
  classifyCloudflareFailure,
  toTryAnswer,
  tryProblem,
} from "./target-response";

function listOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isEnabledForSite(env: TryProxyEnv, siteId: string): boolean {
  switch (env.DOXA_PROD_TRY_PROXY_MODE) {
    case "all":
      return true;
    case "allowlist":
      return listOf(env.DOXA_PROD_TRY_PROXY_SITE_IDS).includes(siteId);
    default:
      return false;
  }
}

/** The target rules, then the host blocklist. */
function readTarget(
  env: TryProxyEnv,
  baseUrl: string,
): Extract<DocsTryTarget, { ok: true }> | null {
  const target = parseDocsTryTarget(baseUrl, listOf(env.DOXA_TRY_RESERVED_ZONES));
  if (!target.ok) return null;
  const blocked = listOf(env.DOXA_TRY_BLOCKED_HOSTS).some((host) =>
    isHostInZone(target.host, host),
  );
  return blocked ? null : target;
}

/**
 * Names one base URL, so a panel that loaded before a settings change cannot
 * send a reader's key to the new target. It is a hash, so the request holds no
 * address that the server could ever read as a target.
 */
async function readTargetId(target: { origin: string; basePath: string }): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(docsTryTargetBaseUrl(target)),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function readTryConfig(
  env: TryProxyEnv,
  context: DocsTryContext,
): Promise<DocsTryConfig> {
  if (!isEnabledForSite(env, context.siteId)) {
    return { mode: "browser", reason: "proxy_off" };
  }
  const target = readTarget(env, context.baseUrl);
  if (!target) return { mode: "browser", reason: "target_not_allowed" };
  return {
    mode: "proxy",
    targetHost: target.host,
    targetBaseUrl: docsTryTargetBaseUrl(target),
    targetId: await readTargetId(target),
    limits: {
      requestBytes: DOCS_TRY_LIMITS.requestBytes,
      responseBytes: DOCS_TRY_LIMITS.responseBytes,
      timeoutMs: DOCS_TRY_LIMITS.firstByteMs,
    },
  };
}

function writeMetric(
  env: TryProxyEnv,
  context: DocsTryContext,
  point: { host: string; method: string; outcome: string; status: number; elapsedMs: number },
): void {
  // No path, query, header or body, because any of these can hold a key.
  try {
    env.TRY_METRICS?.writeDataPoint({
      indexes: [context.siteId],
      blobs: [context.siteId, point.host, point.method, point.outcome],
      doubles: [point.status, point.elapsedMs],
    });
  } catch {
    // A metric must never fail a send.
  }
}

export async function sendTryRequest(input: {
  env: TryProxyEnv;
  body: ReadableStream<Uint8Array> | null;
  context: DocsTryContext;
  now?: () => number;
}): Promise<Response> {
  const { env, body, context } = input;
  const now = input.now ?? Date.now;

  const refuse = (
    code: DocsTryProblemCode,
    details: { host?: string; method?: string; retryAfter?: number; title?: string } = {},
  ): Response => {
    const response = tryProblem(code, {
      ...(details.retryAfter ? { retryAfter: details.retryAfter } : {}),
      ...(details.title ? { title: details.title } : {}),
    });
    writeMetric(env, context, {
      host: details.host ?? "",
      method: details.method ?? "",
      outcome: code,
      status: response.status,
      elapsedMs: 0,
    });
    return response;
  };

  if (!isEnabledForSite(env, context.siteId)) return refuse("try_off");

  const target = readTarget(env, context.baseUrl);
  if (!target) return refuse("target_blocked");
  const host = target.host;

  const wait = await applyTryLimits(env, context, host, new Date(now()));
  if (wait !== null) return refuse("rate_limited", { host, retryAfter: wait });

  const parsed = await readTryRequest(body);
  if (!parsed.ok) return refuse(parsed.code, { host });
  const { request } = parsed;
  const { method } = request;

  if (request.targetId !== (await readTargetId(target))) {
    return refuse("target_changed", { host, method });
  }

  const url = buildTargetUrl(target, request);
  if (!url) return refuse("path_refused", { host, method });

  const headers = buildTargetHeaders(request, context.siteId);
  if (!headers.ok) {
    return refuse("header_refused", {
      host,
      method,
      title: `Doxa does not send the header "${headers.name.slice(0, 64)}".`,
    });
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DOCS_TRY_LIMITS.firstByteMs);
  const startedAt = now();
  let answer: Response;
  try {
    answer = await fetch(url, {
      method,
      headers: headers.headers,
      ...(request.body ? { body: request.body.data } : {}),
      redirect: "manual",
      cache: "no-store",
      signal: abort.signal,
    });
  } catch {
    return refuse(abort.signal.aborted ? "target_timeout" : "target_refused", { host, method });
  } finally {
    clearTimeout(timer);
  }

  const { failure, body: answerBody } = await classifyCloudflareFailure(answer);
  if (failure) return refuse(failure, { host, method });

  const elapsedMs = now() - startedAt;
  writeMetric(env, context, {
    host,
    method,
    outcome: "answered",
    status: answer.status,
    elapsedMs,
  });
  return toTryAnswer({ answer, body: answerBody, requestUrl: url, target, elapsedMs });
}
