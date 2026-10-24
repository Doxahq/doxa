import type { DocsDomainResolution } from "@doxahq/contracts";
import type { PrerenderTaskApiRpc } from "@doxahq/contracts/docs-prerender-tasks";
import {
  DOCS_PRERENDER_LIMITS,
  type PrerenderIdentity,
} from "@doxahq/contracts/docs-prerender";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  isPublicProduction,
  withHtmlCachePolicy,
  withRouteDataCachePolicy,
  withoutResponseCaching,
} from "./cache-policy";
import { toHostResolution } from "./host-resolution";
import { createLiveRouteDataResponse } from "./live-route-data";
import { parsePrerenderMode, shouldUsePrerender } from "./prerender-policy";
import { createPrerenderHtmlResponse } from "./prerender-response";
import { readPrerenderedRoute } from "./prerender-storage";
import { parseSiteAllowlist } from "./rollout-policy";
import {
  attachInternalServerTiming,
  createServerTiming,
  type ServerTimingRecorder,
} from "./server-timing";
import { getWorkerExports } from "./worker-exports";

export type PrerenderRepairTasksRpc = Pick<
  PrerenderTaskApiRpc,
  "enqueueRepair"
>;

export interface PrerenderCacheProps {
  expected: PrerenderIdentity;
  featureMode: "allowlist" | "all";
  hostname: string;
  pathname: string;
  representation: "html" | "data";
  resolution: DocsDomainResolution;
}

interface PrerenderCacheEnv {
  DEBUG?: string;
  DOCS_RENDERED_BUCKET?: R2Bucket;
  PRERENDER_TASKS?: PrerenderRepairTasksRpc;
  DOXA_PROD_PRERENDER_MODE?: string;
  DOXA_PROD_PRERENDER_SITE_IDS?: string;
  DOXA_PRERENDER_REPAIR_ENABLED?: string;
}

/** Cache entrypoint for immutable saved HTML and route data. */
export class DocsPrerenderCache extends WorkerEntrypoint<
  PrerenderCacheEnv,
  PrerenderCacheProps
> {
  async fetch(request: Request): Promise<Response> {
    const {
      expected,
      featureMode,
      hostname,
      pathname,
      representation,
      resolution,
    } = this.ctx.props;
    const requestUrl = new URL(request.url);
    const configuredMode = parsePrerenderMode(
      this.env.DOXA_PROD_PRERENDER_MODE,
    );
    const configuredSiteIds = parseSiteAllowlist(
      this.env.DOXA_PROD_PRERENDER_SITE_IDS,
    );
    if (
      !this.env.DOCS_RENDERED_BUCKET ||
      configuredMode !== featureMode ||
      !shouldUsePrerender(
        configuredMode,
        configuredSiteIds,
        resolution.siteId,
      ) ||
      !isPublicProduction(resolution) ||
      hostname !== requestUrl.hostname ||
      resolution.hostname !== hostname ||
      expected.siteId !== resolution.siteId ||
      expected.trustedRequestOrigin !== requestUrl.origin
    ) {
      return withoutResponseCaching(
        new Response("Invalid pre-render cache request", { status: 400 }),
      );
    }

    const timing = createServerTiming(this.env.DEBUG);
    const lookup = await readPrerenderedRoute({
      bucket: this.env.DOCS_RENDERED_BUCKET,
      expected,
      pathname,
      representation,
      timing,
    });
    enqueuePrerenderRepairIfNeeded({
      env: this.env,
      ctx: this.ctx,
      expected,
      hostname,
      lookup,
      pathname,
      resolution,
    });
    if (representation === "html") {
      const response = createPrerenderHtmlResponse(lookup, request.method);
      return finalizePrerenderResponse(
        response
          ? withHtmlCachePolicy(response)
          : withoutResponseCaching(
              new Response("Saved HTML unavailable", { status: 404 }),
            ),
        lookup,
        timing,
      );
    }
    if (lookup.status === "hit" && lookup.data) {
      return finalizePrerenderResponse(
        withRouteDataCachePolicy(
          new Response(copyToArrayBuffer(lookup.data), {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-content-type-options": "nosniff",
              "x-doxa-representation-source": "prerender",
            },
          }),
          "versioned",
        ),
        lookup,
        timing,
      );
    }
    const live = await createLiveRouteDataResponse(
      getWorkerExports(this.ctx).PrerenderRendererApi({}),
      resolution,
      pathname,
    );
    return finalizePrerenderResponse(
      withRouteDataCachePolicy(live, "liveFallback"),
      lookup,
      timing,
    );
  }
}

function finalizePrerenderResponse(
  response: Response,
  lookup: Awaited<ReturnType<typeof readPrerenderedRoute>>,
  timing: ServerTimingRecorder,
): Response {
  if (timing.enabled) {
    response.headers.set("x-doxa-prerender-lookup", lookup.status);
    if ("reason" in lookup) {
      response.headers.set("x-doxa-prerender-reason", lookup.reason);
    }
  }
  return attachInternalServerTiming(response, timing);
}

/**
 * Repair submissions of this isolate, by render ID, with their cooldown end.
 *
 * A missing manifest cannot be cached, so every visitor request reaches this
 * code. Without a local cooldown, one busy site would send one database
 * transaction per request. The map is an optimization only. The API keeps its
 * own cooldown, which stays correct across isolates.
 */
const repairCooldowns = new Map<string, number>();
const REPAIR_COOLDOWN_CAPACITY = 500;

/** Test hook. Production code never clears the cooldown map. */
export function clearRepairCooldowns(): void {
  repairCooldowns.clear();
}

export function shouldSubmitRepair(
  renderId: string,
  now: number = Date.now(),
  cooldowns: Map<string, number> = repairCooldowns,
): boolean {
  const cooldownEndsAt = cooldowns.get(renderId);
  if (cooldownEndsAt !== undefined && cooldownEndsAt > now) return false;
  if (cooldowns.size >= REPAIR_COOLDOWN_CAPACITY) {
    for (const [key, expiresAt] of cooldowns) {
      if (expiresAt <= now) cooldowns.delete(key);
    }
    if (cooldowns.size >= REPAIR_COOLDOWN_CAPACITY) {
      const oldest = cooldowns.keys().next();
      if (!oldest.done) cooldowns.delete(oldest.value);
    }
  }
  cooldowns.delete(renderId);
  cooldowns.set(
    renderId,
    now + DOCS_PRERENDER_LIMITS.repairCooldownSeconds * 1_000,
  );
  return true;
}

function enqueuePrerenderRepairIfNeeded(input: {
  env: PrerenderCacheEnv;
  ctx: ExecutionContext;
  expected: PrerenderIdentity;
  hostname: string;
  lookup: Awaited<ReturnType<typeof readPrerenderedRoute>>;
  pathname: string;
  resolution: DocsDomainResolution;
}): void {
  if (
    input.env.DOXA_PRERENDER_REPAIR_ENABLED !== "true" ||
    !input.env.PRERENDER_TASKS
  ) {
    return;
  }
  const reason =
    input.lookup.status === "miss" && input.lookup.reason === "manifest_missing"
      ? "manifest_missing"
      : input.lookup.status === "invalid"
        ? "invalid_output"
        : null;
  if (!reason) return;
  if (!shouldSubmitRepair(input.expected.renderId)) return;

  const requestId = crypto.randomUUID();
  input.ctx.waitUntil(
    input.env.PRERENDER_TASKS.enqueueRepair({
      resolution: toHostResolution(input.resolution),
      identity: input.expected,
      pathname: input.pathname,
      reason,
    }).catch((error) => {
      console.error(
        JSON.stringify({
          service: "doxa-docs-dispatcher",
          eventType: "docs_prerender_repair_enqueue_failed",
          requestId,
          siteId: input.expected.siteId,
          hostname: input.hostname,
          renderId: input.expected.renderId,
          expectedRoute: input.pathname,
          reason,
          errorClass: error instanceof Error ? error.name : "UnknownError",
          errorMessage: sanitizeOperationalError(error),
        }),
      );
    }),
  );
}

function sanitizeOperationalError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Repair submission failed.";
  return message
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
