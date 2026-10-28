import {
  DOCS_PRERENDER_SCHEMA_VERSION,
  type PublicRouteDataResponse,
} from "@doxahq/contracts/docs-prerender";
import type { PublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";
import { createServerFn } from "@tanstack/react-start";

import {
  getDocsRouteRawDocument,
  resolveDocsRootRouteData,
  resolveDocsRouteData,
  type ResolveDocsRouteDataOptions,
} from "./docs-route-data";
import {
  DocsRenderVersionMismatchError,
  loadProductionRouteData,
  startVersionMismatchNavigation,
} from "./production-route-data";
import type { DocsRequestContext } from "./request-context";
import type { DoxaDocsRuntimeSource } from "./runtime-source";
import {
  createConfiguredRuntimeSource,
  getRuntimeSourceMode,
} from "./runtime-source-selection";
import {
  createRuntimeTimingSink,
  isRuntimeTimingEnabled,
} from "./runtime-timing";

interface DocsRouteInput {
  pathname: string;
}

interface ProductionRouteInput extends DocsRouteInput {
  expectedRenderId: string;
}

export const loadDocsRouteData = createServerFn({ method: "GET" })
  .inputValidator((input: DocsRouteInput) => input)
  .handler(async ({ data, context }) => {
    const requestContext = context ?? {};
    const prepared = getPreparedRouteData(requestContext, data.pathname);
    if (prepared) return prepared;

    return loadConfiguredDocsRouteData(
      data.pathname,
      "loadDocsRouteData",
      (source, options) => resolveDocsRouteData(source, data.pathname, options),
      requestContext
    );
  });

export const loadDocsRawPage = createServerFn({ method: "GET" })
  .inputValidator((slugOrHref: string) => slugOrHref)
  .handler(async ({ data, context }) => {
    const requestContext = (context ?? {}) as DocsRequestContext;
    const source =
      requestContext.runtimeSource ?? (await createConfiguredRuntimeSource());

    return getDocsRouteRawDocument(source, data);
  });

export const loadDocsDeliveryCapability = createServerFn({
  method: "GET",
}).handler(async ({ context }) => {
  const requestContext: DocsRequestContext = context ?? {};
  return requestContext.delivery ?? null;
});

export const loadDocsProductionRouteData = createServerFn({ method: "GET" })
  .inputValidator((input: ProductionRouteInput) => input)
  .handler(async ({ data, context }): Promise<PublicRouteDataResponse> => {
    const requestContext: DocsRequestContext = context ?? {};
    if (requestContext.delivery?.renderId !== data.expectedRenderId) {
      return { status: "version_mismatch" };
    }
    try {
      const routeData = await loadConfiguredDocsRouteData(
        data.pathname,
        "loadDocsProductionRouteData",
        data.pathname === "/"
          ? resolveDocsRootRouteData
          : (source, options) =>
              resolveDocsRouteData(source, data.pathname, options),
        requestContext
      );
      return {
        status: "ok",
        schemaVersion: DOCS_PRERENDER_SCHEMA_VERSION,
        renderId: data.expectedRenderId,
        data: routeData,
      };
    } catch {
      return { status: "unavailable", retryable: true };
    }
  });

export const loadDocsRootRouteData = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const requestContext = context ?? {};
    const prepared = getPreparedRouteData(requestContext, "/");
    if (prepared) return prepared;

    return loadConfiguredDocsRouteData(
      "/",
      "loadDocsRootRouteData",
      resolveDocsRootRouteData,
      requestContext
    );
  }
);

function getPreparedRouteData(
  context: DocsRequestContext,
  pathname: string
): PublicDocsRouteDataV1 | undefined {
  return context.preparedRoute?.pathname === pathname
    ? context.preparedRoute.data
    : undefined;
}

export async function loadDocsRouteDataForNavigation(
  pathname: string,
  signal?: AbortSignal,
  navigation?: { destinationHref: string; preload: boolean }
): Promise<PublicDocsRouteDataV1> {
  if (typeof window === "undefined") {
    return pathname === "/"
      ? loadDocsRootRouteData()
      : loadDocsRouteData({ data: { pathname } });
  }
  const capability = window.__DOXA_DOCS_DELIVERY__;
  if (!capability) {
    return pathname === "/"
      ? loadDocsRootRouteData()
      : loadDocsRouteData({ data: { pathname } });
  }

  try {
    return await loadProductionRouteData({
      pathname,
      capability,
      ...(signal ? { signal } : {}),
      liveFallback: (fallbackPathname, expectedRenderId) =>
        loadDocsProductionRouteData({
          data: { pathname: fallbackPathname, expectedRenderId },
        }),
    });
  } catch (error) {
    if (
      error instanceof DocsRenderVersionMismatchError &&
      navigation &&
      startVersionMismatchNavigation(navigation)
    ) {
      return await new Promise<never>(() => undefined);
    }
    throw error;
  }
}

declare global {
  interface Window {
    __DOXA_DOCS_DELIVERY__?: DocsRequestContext["delivery"];
  }
}

async function loadConfiguredDocsRouteData<T>(
  pathname: string,
  component: string,
  resolver: (
    source: DoxaDocsRuntimeSource,
    options: ResolveDocsRouteDataOptions
  ) => Promise<T>,
  requestContext: DocsRequestContext
): Promise<T> {
  const { loadServerPageHighlighting } = await import("./server-highlighter");
  const source =
    requestContext.runtimeSource ?? (await createConfiguredRuntimeSource());
  const mode = requestContext.runtimeSourceMode ?? getRuntimeSourceMode();
  const timing = createRuntimeTimingSink(isRuntimeTimingEnabled(), {
    component,
    mode,
    pathname,
  });

  return resolver(source, {
    includeRawDocument: false,
    includeRuntimeDocument: mode !== "vite",
    highlighting: await loadServerPageHighlighting(),
    timing,
  });
}
