import type { ResolvedSiteConfig } from "@doxahq/site-config";
import { z } from "zod";

import {
  normalizeRuntimeHref,
  type DoxaDocsRuntimeSource,
  type RuntimeCompanyConfig,
  type RuntimeFeatureConfig,
  type RuntimeNavNode,
  type RuntimeNavPage,
  type RuntimePage,
  type RuntimePageResolution,
  type RuntimeRawPage,
  type RuntimeRouteData,
  type RuntimeSection,
  type RuntimeSiteConfig,
  type RuntimeSocialConfig,
  type RuntimeThemeConfig,
} from "./runtime-source";
import { RuntimeSourceError } from "./runtime-source-error";
import {
  createRuntimeTimingSink,
  elapsed,
  estimateJsonSize,
  now,
  type RuntimeTimingSink,
} from "./runtime-timing";

type PlatformRuntimeOperation =
  | "getResolvedSiteConfig"
  | "getSiteConfig"
  | "getCompanyConfig"
  | "getSocialConfig"
  | "getThemeConfig"
  | "getFeatureConfig"
  | "getSections"
  | "getNavigation"
  | "getRoutes"
  | "getHomeHref"
  | "getRouteData"
  | "resolvePage"
  | "getPage"
  | "getRawPage"
  | "getSearchIndex"
  | "getCompiledSearchIndex";

type FetchLike = typeof fetch;

export interface PlatformRuntimeSourceConfig {
  contentWorkerUrl: string;
  accessToken: string;
  hostname?: string;
  projectId?: string;
  runtimePath?: string;
  timingEnabled?: boolean;
  fetch?: FetchLike;
}

type PlatformRuntimeScope =
  | {
      kind: "host";
      value: string;
    }
  | {
      kind: "project";
      value: string;
    };

interface PlatformRuntimeRequest {
  operation: PlatformRuntimeOperation;
  payload?: unknown;
}

type PlatformRuntimeResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error?: {
        code?: string;
        message?: string;
      };
    };

export function createPlatformRuntimeSource(
  config: PlatformRuntimeSourceConfig
): DoxaDocsRuntimeSource {
  const client = createPlatformRuntimeClient(config);
  const fetchAsset = (path: string) => {
    const endpoint = resolvePlatformRuntimeEndpoint(
      config.contentWorkerUrl,
      config.runtimePath
    );
    return (config.fetch ?? globalThis.fetch)(`${endpoint}/${path}`, {
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        ...getRuntimeScopeHeaders(resolveRuntimeScope(config)),
      },
    });
  };
  const scope = resolveRuntimeScope(config);

  return {
    cacheScope: `${scope.kind}:${scope.value}`,
    getAsset: (hash) => fetchAsset(`assets/${encodeURIComponent(hash)}`),
    getVersionAsset: (name, version) =>
      fetchAsset(
        `version-assets/${encodeURIComponent(name)}${
          version ? `?v=${encodeURIComponent(version)}` : ""
        }`
      ),
    getRouteData: (pathname) =>
      client.request<RuntimeRouteData>("getRouteData", {
        pathname: normalizeRuntimeHref(pathname),
      }),
    getResolvedSiteConfig: () =>
      client.request<ResolvedSiteConfig>("getResolvedSiteConfig"),
    getSiteConfig: () => client.request<RuntimeSiteConfig>("getSiteConfig"),
    getCompanyConfig: () =>
      client.request<RuntimeCompanyConfig>("getCompanyConfig"),
    getSocialConfig: () =>
      client.request<RuntimeSocialConfig>("getSocialConfig"),
    getThemeConfig: () => client.request<RuntimeThemeConfig>("getThemeConfig"),
    getFeatureConfig: () =>
      client.request<RuntimeFeatureConfig>("getFeatureConfig"),
    getSections: () => client.request<RuntimeSection[]>("getSections"),
    getNavigation: (sectionSlug) =>
      client.request<RuntimeNavNode[]>("getNavigation", { sectionSlug }),
    getRoutes: (sectionSlug) =>
      client.request<RuntimeNavPage[]>("getRoutes", { sectionSlug }),
    getHomeHref: async () => {
      const href = await client.request<string | null>("getHomeHref");
      return href ? normalizeRuntimeHref(href) : null;
    },
    resolvePage: (pathname) =>
      client.request<RuntimePageResolution>("resolvePage", {
        pathname: normalizeRuntimeHref(pathname),
      }),
    getPage: (slug) =>
      client.request<RuntimePage | null>("getPage", {
        slug: normalizeRuntimeHref(slug),
      }),
    getRawPage: (slug) =>
      client.request<RuntimeRawPage | null>("getRawPage", {
        slug: normalizeRuntimeHref(slug),
      }),
    getSearchIndex: () => client.request<string | null>("getSearchIndex"),
    getCompiledSearchIndex: () =>
      client.request<string | null>("getCompiledSearchIndex"),
  };
}

function createPlatformRuntimeClient(config: PlatformRuntimeSourceConfig) {
  const endpoint = resolvePlatformRuntimeEndpoint(
    requireConfigValue(config.contentWorkerUrl, "contentWorkerUrl"),
    config.runtimePath
  );
  const accessToken = requireConfigValue(config.accessToken, "accessToken");
  const scope = resolveRuntimeScope(config);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const cache = new Map<string, Promise<unknown>>();
  const timing = createRuntimeTimingSink(config.timingEnabled ?? false, {
    component: "platformRuntimeSource",
    scopeKind: scope.kind,
  });

  if (!fetchImpl) {
    throw new Error("[platform-runtime-source] fetch is not available.");
  }

  return {
    request<T>(operation: PlatformRuntimeOperation, payload?: unknown) {
      const cacheKey = JSON.stringify([operation, payload ?? null]);
      const existing = cache.get(cacheKey);
      if (existing) {
        timing.mark("platform.operation.cacheHit", { operation });
        return existing as Promise<T>;
      }

      const promise = requestPlatformRuntime<T>(fetchImpl, endpoint, {
        accessToken,
        scope,
        operation,
        payload,
        timing,
      });
      cache.set(cacheKey, promise);
      return promise;
    },
  };
}

async function requestPlatformRuntime<T>(
  fetchImpl: FetchLike,
  endpoint: string,
  input: PlatformRuntimeRequest & {
    accessToken: string;
    scope: PlatformRuntimeScope;
    timing: RuntimeTimingSink;
  }
): Promise<T> {
  const startedAt = now();
  const request: PlatformRuntimeRequest = {
    operation: input.operation,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };
  let status = 0;
  let logged = false;

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
        "x-doxa-runtime-source-version": "1",
        ...getRuntimeScopeHeaders(input.scope),
      },
      body: JSON.stringify(request),
    });
    status = response.status;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const parsed = z
        .object({ error: z.object({ code: z.string() }) })
        .safeParse(parseErrorBody(body));
      throw new RuntimeSourceError(
        `[platform-runtime-source] ${input.operation} failed with ${response.status}: ${body || response.statusText}`,
        parsed.success ? parsed.data.error.code : undefined
      );
    }

    const json = (await response.json()) as PlatformRuntimeResponse<T>;
    input.timing.mark("platform.operation", {
      operation: input.operation,
      status,
      ok: json.ok === true,
      durationMs: elapsed(startedAt),
      requestBytes: estimateJsonSize(request),
      responseBytes: estimateJsonSize(json),
    });
    logged = true;

    if (json.ok === true) return json.data;

    const message =
      json.ok === false
        ? (json.error?.message ?? json.error?.code ?? "Unknown platform error")
        : "Invalid platform runtime response";
    throw new RuntimeSourceError(
      `[platform-runtime-source] ${input.operation}: ${message}`,
      json.ok === false ? json.error?.code : undefined
    );
  } catch (error) {
    if (!logged) {
      input.timing.mark("platform.operation", {
        operation: input.operation,
        status,
        ok: false,
        durationMs: elapsed(startedAt),
        requestBytes: estimateJsonSize(request),
        errorName:
          error instanceof Error ? error.name || "Error" : "UnknownError",
      });
    }
    throw error;
  }
}

function resolvePlatformRuntimeEndpoint(
  contentWorkerUrl: string,
  runtimePath = "/runtime-source"
): string {
  const base = contentWorkerUrl.replace(/\/+$/, "");
  const path = runtimePath.startsWith("/") ? runtimePath : `/${runtimePath}`;
  return `${base}${path}`;
}

function resolveRuntimeScope(
  config: Pick<PlatformRuntimeSourceConfig, "hostname" | "projectId">
): PlatformRuntimeScope {
  const hostname = config.hostname?.trim();
  if (hostname) {
    return { kind: "host", value: hostname };
  }

  const projectId = config.projectId?.trim();
  if (projectId) {
    return { kind: "project", value: projectId };
  }

  throw new Error("[platform-runtime-source] Missing hostname or projectId.");
}

function getRuntimeScopeHeaders(
  scope: PlatformRuntimeScope
): Record<string, string> {
  return scope.kind === "host"
    ? { "x-doxa-host": scope.value }
    : { "x-doxa-project-id": scope.value };
}

function requireConfigValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`[platform-runtime-source] Missing ${name}.`);
  }
  return trimmed;
}

function parseErrorBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
