import type { ResolvedSiteConfig } from "@doxahq/site-config";

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

export interface BindingRuntimeResolution {
  siteId: string;
  projectId: string;
  projectSlug: string;
  publishedVersionId: string;
  artifactPrefix: string;
  manifestPath: string;
  accessPolicy: "public" | "authenticated";
}

type BindingRuntimeOperation =
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

interface BindingRuntimeRequest {
  resolution: BindingRuntimeResolution;
  operation: BindingRuntimeOperation;
  payload?: unknown;
}

interface HostBindingRuntimeRequest {
  hostname: string;
  operation: BindingRuntimeOperation;
  payload?: unknown;
}

type BindingRuntimeResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface DocsContentBinding {
  asset?(input: {
    resolution?: BindingRuntimeResolution;
    hostname?: string;
    hash: string;
  }): Promise<Response>;
  versionAsset?(input: {
    resolution?: BindingRuntimeResolution;
    hostname?: string;
    name: string;
    version?: string | null;
  }): Promise<Response>;
  request(
    input: BindingRuntimeRequest | HostBindingRuntimeRequest
  ): Promise<BindingRuntimeResponse>;
}

export type BindingRuntimeSourceConfig =
  | {
      binding: DocsContentBinding;
      resolution: BindingRuntimeResolution;
    }
  | {
      binding: DocsContentBinding;
      hostname: string;
    };

export function createBindingRuntimeSource(
  config: BindingRuntimeSourceConfig
): DoxaDocsRuntimeSource {
  const request = createBindingRuntimeClient(config);
  const scope =
    "resolution" in config
      ? { resolution: config.resolution }
      : { hostname: config.hostname };

  return {
    getAsset: (hash) =>
      config.binding.asset
        ? config.binding.asset({ ...scope, hash })
        : Promise.resolve(new Response(null, { status: 503 })),
    getVersionAsset: (name, version) =>
      config.binding.versionAsset
        ? config.binding.versionAsset({
            ...scope,
            name,
            ...(version ? { version } : {}),
          })
        : Promise.resolve(new Response(null, { status: 503 })),
    getRouteData: (pathname) =>
      request<RuntimeRouteData>("getRouteData", {
        pathname: normalizeRuntimeHref(pathname),
      }),
    getResolvedSiteConfig: () =>
      request<ResolvedSiteConfig>("getResolvedSiteConfig"),
    getSiteConfig: () => request<RuntimeSiteConfig>("getSiteConfig"),
    getCompanyConfig: () => request<RuntimeCompanyConfig>("getCompanyConfig"),
    getSocialConfig: () => request<RuntimeSocialConfig>("getSocialConfig"),
    getThemeConfig: () => request<RuntimeThemeConfig>("getThemeConfig"),
    getFeatureConfig: () => request<RuntimeFeatureConfig>("getFeatureConfig"),
    getSections: () => request<RuntimeSection[]>("getSections"),
    getNavigation: (sectionSlug) =>
      request<RuntimeNavNode[]>("getNavigation", { sectionSlug }),
    getRoutes: (sectionSlug) =>
      request<RuntimeNavPage[]>("getRoutes", { sectionSlug }),
    getHomeHref: () => request<string | null>("getHomeHref"),
    resolvePage: (pathname) =>
      request<RuntimePageResolution>("resolvePage", {
        pathname: normalizeRuntimeHref(pathname),
      }),
    getPage: (slug) =>
      request<RuntimePage | null>("getPage", {
        slug: normalizeRuntimeHref(slug),
      }),
    getRawPage: (slug) =>
      request<RuntimeRawPage | null>("getRawPage", {
        slug: normalizeRuntimeHref(slug),
      }),
    getSearchIndex: () => request<string | null>("getSearchIndex"),
    getCompiledSearchIndex: () =>
      request<string | null>("getCompiledSearchIndex"),
  };
}

function createBindingRuntimeClient(config: BindingRuntimeSourceConfig) {
  const cache = new Map<string, Promise<unknown>>();

  return function request<T>(
    operation: BindingRuntimeOperation,
    payload?: unknown
  ): Promise<T> {
    const cacheKey = JSON.stringify([operation, payload ?? null]);
    const existing = cache.get(cacheKey);
    if (existing) return existing as Promise<T>;

    const scope =
      "resolution" in config
        ? { resolution: config.resolution }
        : { hostname: config.hostname };
    const pending = config.binding
      .request({
        ...scope,
        operation,
        ...(payload === undefined ? {} : { payload }),
      })
      .then((response) => {
        if (response.ok) return response.data as T;
        throw new RuntimeSourceError(
          `[binding-runtime-source] ${operation}: ${response.error.message}`,
          response.error.code
        );
      });
    cache.set(cacheKey, pending);
    return pending;
  };
}
