import { preparePublicDocsRouteData } from "@/src/runtime/prerender-renderer";
import type { DocsRequestContext } from "@/src/runtime/request-context";
import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import {
  createConfiguredRuntimeSource,
  createDispatcherRuntimeSource,
  type RendererWorkerEnv,
} from "@/src/runtime/runtime-source-selection";
import { loadSiteConfig } from "@/src/site-config/load-site-config";
import {
  docsAssetNameFromUrlPath,
  docsAssetVersionFromUrl,
} from "@doxahq/contracts/docs-assets";
import type { PublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";
import {
  normalizePublicDocsPathname,
  parsePublicDocsRouteDataV1,
  sha256Schema,
} from "@doxahq/contracts/docs-prerender";
import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { WorkerEntrypoint } from "cloudflare:workers";

import { getAccessGateResponse } from "@/src/lib/access-gate";
import { tryRawMarkdownResponse } from "@/src/lib/raw-markdown";
import { getRendererHealthResponse } from "@/src/lib/renderer-health";
import { getRedirectResponse } from "@/src/lib/request-redirects";

interface DocsStartRegister {
  server: {
    requestContext: DocsRequestContext;
  };
}

const startHandler =
  createStartHandler<DocsStartRegister>(defaultStreamHandler);

interface RenderPreparedDocsRequestInput {
  runtimeSource: DoxaDocsRuntimeSource;
  pathname: string;
  routeData: PublicDocsRouteDataV1;
  renderId: string;
}

export async function renderPreparedDocsRequest(
  request: Request,
  input: RenderPreparedDocsRequestInput
): Promise<Response> {
  const context: DocsRequestContext = {
    siteConfig: await loadSiteConfig(input.runtimeSource),
    delivery: {
      mode: "public-production",
      renderId: input.renderId,
      schemaVersion: 1,
    },
    preparedRoute: { pathname: input.pathname, data: input.routeData },
    runtimeSource: input.runtimeSource,
    runtimeSourceMode: "binding",
  };
  return startHandler(request, { context });
}

interface PrepareRouteInput {
  pathname: string;
}

interface RenderRouteInput extends PrepareRouteInput {
  requestUrl: string;
  renderId: string;
  routeData: unknown;
}

/** Private RPC entrypoint used only by the pre-render Worker and dispatcher. */
export class DocsPrerenderRenderer extends WorkerEntrypoint<RendererWorkerEnv> {
  async prepare(input: PrepareRouteInput): Promise<PublicDocsRouteDataV1> {
    const pathname = normalizePublicDocsPathname(input.pathname);
    return preparePublicDocsRouteData(this.getRuntimeSource(), pathname);
  }

  async render(input: RenderRouteInput): Promise<Response> {
    const pathname = normalizePublicDocsPathname(input.pathname);
    const url = new URL(input.requestUrl);
    if (
      url.protocol !== "https:" ||
      url.pathname !== pathname ||
      url.search ||
      url.hash
    ) {
      throw new Error("The private render request URL is invalid.");
    }
    if (!/^[a-f0-9]{64}$/.test(input.renderId)) {
      throw new Error("The private render identity is invalid.");
    }
    return renderPreparedDocsRequest(
      new Request(url, { headers: { accept: "text/html" } }),
      {
        runtimeSource: this.getRuntimeSource(),
        pathname,
        routeData: parsePublicDocsRouteDataV1(input.routeData),
        renderId: input.renderId,
      }
    );
  }

  private getRuntimeSource(): DoxaDocsRuntimeSource {
    const source = createDispatcherRuntimeSource(this.env);
    if (!source) {
      throw new Error("The private renderer requires a pinned content source.");
    }
    return source;
  }
}

const server = {
  async fetch(request: Request, env?: RendererWorkerEnv) {
    const { host, hostname, pathname } = new URL(request.url);
    const runtimeSource = createDispatcherRuntimeSource(env, hostname);

    const health = getRendererHealthResponse(request);
    if (health) return health;

    const redirect = getRedirectResponse(request);
    if (redirect) return redirect;

    const gate = await getAccessGateResponse(request);
    if (gate) return gate;

    if (pathname.startsWith("/_doxa/assets/")) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405 });
      const hash = sha256Schema.safeParse(
        pathname.slice("/_doxa/assets/".length)
      );
      if (!hash.success) return new Response(null, { status: 404 });
      // This branch runs before TanStack Start, so the platform source cannot
      // read the host from a Start request context. Pass it from the request.
      // `host` keeps the port, like `getRequestHost` on the page render path.
      const source =
        runtimeSource ??
        (await createConfiguredRuntimeSource(process.env, host));
      const response =
        (await source.getAsset?.(hash.data)) ??
        new Response(null, { status: 404 });
      return request.method === "HEAD"
        ? new Response(null, response)
        : response;
    }

    const versionAsset = await tryVersionAssetResponse(
      request,
      runtimeSource,
      host
    );
    if (versionAsset) return versionAsset;

    const rawMarkdown = await tryRawMarkdownResponse(pathname, runtimeSource);
    if (rawMarkdown) return rawMarkdown;

    const context: DocsRequestContext = runtimeSource
      ? {
          runtimeSource,
          runtimeSourceMode: "binding",
          ...getTrustedDeliveryContext(request),
        }
      : {};
    if (
      runtimeSource &&
      request.method === "GET" &&
      request.headers.get("accept")?.includes("text/html")
    ) {
      const route = await runtimeSource.getRouteData?.(pathname);
      context.siteConfig = await loadSiteConfig(runtimeSource, route);
    }
    return startHandler(request, { context });
  },
};

/**
 * An image of the served version at `/assets/{name}`. A miss falls through,
 * so a renderer file of the same shape still reaches the normal pipeline.
 */
async function tryVersionAssetResponse(
  request: Request,
  runtimeSource: DoxaDocsRuntimeSource | null | undefined,
  host: string
): Promise<Response | null> {
  const url = new URL(request.url);
  const name = docsAssetNameFromUrlPath(url.pathname);
  if (!name || (request.method !== "GET" && request.method !== "HEAD"))
    return null;
  const source =
    runtimeSource ?? (await createConfiguredRuntimeSource(process.env, host));
  const response = await source.getVersionAsset?.(
    name,
    docsAssetVersionFromUrl(url)
  );
  if (!response || response.status === 404) return null;
  return request.method === "HEAD" ? new Response(null, response) : response;
}

function getTrustedDeliveryContext(
  request: Request
): Pick<DocsRequestContext, "delivery"> | Record<string, never> {
  const renderId = request.headers.get("x-doxa-internal-render-id")?.trim();
  if (!renderId || !/^[a-f0-9]{64}$/.test(renderId)) return {};
  return {
    delivery: {
      mode: "public-production",
      renderId,
      schemaVersion: 1,
    },
  };
}

export default server;
