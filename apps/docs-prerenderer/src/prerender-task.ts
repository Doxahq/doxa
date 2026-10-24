import {
  DOCS_PRERENDER_LIMITS,
  normalizePublicDocsPathname,
  parsePublicDocsRouteDataV1,
  type PrerenderIdentity,
  type PrerenderManifestV1,
  type PublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";

import {
  commitPrerenderManifest,
  writePrerenderObject,
  type PrerenderWriteBucket,
} from "./storage-writer";
import { PrerenderPermanentError } from "./prerender-errors";

type PrerenderPlanEntry =
  | { kind: "page"; pathname: string }
  | {
      kind: "live_only";
      pathname: string;
      reason: "unsupported_route" | "resource_limit";
    }
  | {
      kind: "redirect";
      pathname: string;
      target: string;
      status: 301 | 302 | 303 | 307 | 308;
    };

export interface PrerenderRenderer {
  getPlan(): Promise<unknown>;
  prepare(pathname: string): Promise<unknown>;
  render(input: {
    pathname: string;
    requestUrl: string;
    renderId: string;
    routeData: PublicDocsRouteDataV1;
  }): Promise<Response>;
}

export interface ExecutePrerenderTaskInput {
  identity: PrerenderIdentity;
  renderer: PrerenderRenderer;
  bucket: PrerenderWriteBucket;
  now(): Date;
  onProgress?(progress: {
    completedRoutes: number;
    totalRoutes: number;
  }): Promise<void>;
}

export async function executePrerenderTask(
  input: ExecutePrerenderTaskInput,
): Promise<{ status: "committed" | "already_complete"; routeCount: number }> {
  let plan: PrerenderPlanEntry[];
  try {
    plan = parsePrerenderPlan(await input.renderer.getPlan());
  } catch (error) {
    if (error instanceof PrerenderPermanentError) throw error;
    throw new PrerenderPermanentError("The pre-render plan is invalid.", {
      cause: error,
    });
  }
  const routes: PrerenderManifestV1["routes"] = [];
  for (
    let offset = 0;
    offset < plan.length;
    offset += DOCS_PRERENDER_LIMITS.concurrentRoutes
  ) {
    const batch = plan.slice(
      offset,
      offset + DOCS_PRERENDER_LIMITS.concurrentRoutes,
    );
    routes.push(
      ...(await Promise.all(batch.map((route) => renderRoute(input, route)))),
    );
    await input.onProgress?.({
      completedRoutes: routes.length,
      totalRoutes: plan.length,
    });
  }

  const result = await commitPrerenderManifest({
    bucket: input.bucket,
    manifest: {
      schemaVersion: 1,
      identity: input.identity,
      completedAt: input.now().toISOString(),
      routes,
    },
  });
  return { status: result.status, routeCount: routes.length };
}

async function renderRoute(
  input: ExecutePrerenderTaskInput,
  route: PrerenderPlanEntry,
): Promise<PrerenderManifestV1["routes"][number]> {
  if (route.kind === "live_only") return route;
  let routeData: PublicDocsRouteDataV1;
  try {
    routeData = parsePublicDocsRouteDataV1(
      await input.renderer.prepare(route.pathname),
    );
  } catch (error) {
    throw new PrerenderPermanentError(
      `The renderer returned invalid route data for ${route.pathname}.`,
      { cause: error },
    );
  }
  const dataBytes = new TextEncoder().encode(JSON.stringify(routeData));
  if (dataBytes.byteLength > DOCS_PRERENDER_LIMITS.jsonBytes) {
    return {
      kind: "live_only",
      pathname: route.pathname,
      reason: "route_data_too_large",
    };
  }

  if (route.kind === "redirect") {
    if (
      routeData.type !== "redirect" ||
      routeData.href !== route.target ||
      routeData.status !== route.status
    ) {
      throw new PrerenderPermanentError(
        `Prepared redirect does not match the route plan: ${route.pathname}`,
      );
    }
    const data = await writePrerenderObject({
      bucket: input.bucket,
      identity: input.identity,
      bytes: dataBytes,
      extension: "json",
    });
    if (data.contentType !== "application/json; charset=utf-8") {
      throw new Error("Unexpected route-data object type.");
    }
    return {
      kind: "redirect",
      pathname: route.pathname,
      target: route.target,
      status: route.status,
      data,
    };
  }

  if (routeData.type !== "page") {
    throw new PrerenderPermanentError(
      `Prepared page does not match the route plan: ${route.pathname}`,
    );
  }
  const response = await input.renderer.render({
    pathname: route.pathname,
    requestUrl: `${input.identity.trustedRequestOrigin}${route.pathname}`,
    renderId: input.identity.renderId,
    routeData,
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    const message = `The renderer returned HTTP ${response.status} for ${route.pathname}.`;
    if (response.status >= 400 && response.status < 500) {
      throw new PrerenderPermanentError(message);
    }
    throw new Error(message);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/html")) {
    await response.body?.cancel();
    throw new PrerenderPermanentError(
      `The renderer returned a non-HTML response for ${route.pathname}.`,
    );
  }
  const htmlBytes = await readBoundedResponse(
    response,
    DOCS_PRERENDER_LIMITS.htmlBytes,
  );
  if (!htmlBytes) {
    return {
      kind: "live_only",
      pathname: route.pathname,
      reason: "html_too_large",
    };
  }
  const [html, data] = await Promise.all([
    writePrerenderObject({
      bucket: input.bucket,
      identity: input.identity,
      bytes: htmlBytes,
      extension: "html",
    }),
    writePrerenderObject({
      bucket: input.bucket,
      identity: input.identity,
      bytes: dataBytes,
      extension: "json",
    }),
  ]);
  if (
    html.contentType !== "text/html; charset=utf-8" ||
    data.contentType !== "application/json; charset=utf-8"
  ) {
    throw new Error("Unexpected pre-render object type.");
  }
  return { kind: "page", pathname: route.pathname, html, data };
}

function parsePrerenderPlan(value: unknown): PrerenderPlanEntry[] {
  if (
    !Array.isArray(value) ||
    value.length > DOCS_PRERENDER_LIMITS.manifestRoutes
  ) {
    throw new PrerenderPermanentError(
      "The pre-render plan is invalid or exceeds the route limit.",
    );
  }
  const entries: PrerenderPlanEntry[] = [];
  const pathnames = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      (item.kind !== "page" &&
        item.kind !== "redirect" &&
        item.kind !== "live_only")
    ) {
      throw new PrerenderPermanentError(
        "The pre-render plan contains an invalid entry.",
      );
    }
    if (typeof item.pathname !== "string") {
      throw new PrerenderPermanentError(
        "The pre-render plan contains an invalid pathname.",
      );
    }
    const pathname = normalizePublicDocsPathname(item.pathname);
    if (pathname !== item.pathname || pathnames.has(pathname)) {
      throw new PrerenderPermanentError(
        "The pre-render plan contains a duplicate or non-normalized path.",
      );
    }
    pathnames.add(pathname);
    if (item.kind === "page") {
      entries.push({ kind: "page", pathname });
      continue;
    }
    if (item.kind === "live_only") {
      if (
        item.reason !== "unsupported_route" &&
        item.reason !== "resource_limit"
      ) {
        throw new PrerenderPermanentError(
          "The pre-render plan contains an invalid live-only reason.",
        );
      }
      entries.push({ kind: "live_only", pathname, reason: item.reason });
      continue;
    }
    if (
      typeof item.target !== "string" ||
      normalizePublicDocsPathname(item.target) !== item.target ||
      !isRedirectStatus(item.status)
    ) {
      throw new PrerenderPermanentError(
        "The pre-render plan contains an invalid redirect.",
      );
    }
    entries.push({
      kind: "redirect",
      pathname,
      target: item.target,
      status: item.status,
    });
  }
  const pagePaths = new Set(
    entries
      .filter((entry) => entry.kind === "page")
      .map((entry) => entry.pathname),
  );
  if (
    entries.some(
      (entry) => entry.kind === "redirect" && !pagePaths.has(entry.target),
    )
  ) {
    throw new PrerenderPermanentError(
      "The pre-render plan contains a redirect outside its page set.",
    );
  }
  return entries.sort((left, right) =>
    left.pathname.localeCompare(right.pathname),
  );
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRedirectStatus(
  value: unknown,
): value is 301 | 302 | 303 | 307 | 308 {
  return (
    value === 301 ||
    value === 302 ||
    value === 303 ||
    value === 307 ||
    value === 308
  );
}
