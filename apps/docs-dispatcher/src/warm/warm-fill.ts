import {
  fetchPublicCacheCall,
  selectPublicCacheCalls,
  type PublicCacheCall,
  type PublicCacheCallEnv,
} from "../public-cache-calls";
import {
  fetchWithoutProbeMarker,
  probeCache,
} from "../versioned-entrypoint-protocol";
import type { DispatcherExports } from "../worker-exports";
import type { WarmTarget } from "./warm-job";
import { toRequestPathname } from "./warm-pages";

/**
 * One warm fill is one cache-entrypoint call through `ctx.exports`, built by
 * `selectPublicCacheCalls`: the exact entrypoint, props and canonical request
 * of a visitor, so the warmer fills the keys visitors read (F5). Never a
 * global fetch to a customer hostname (F34).
 */
export type WarmCacheExports = Pick<
  DispatcherExports,
  "DocsHtmlCache" | "DocsPrerenderCache" | "DocsRouteDataCache"
>;

export interface WarmUnit {
  hostname: string;
  pathname: string;
  representation: "html" | "data";
}

export type FillOutcome =
  /** Stored or already stored: a 2xx/3xx/4xx answer that is not the marker. */
  | "filled"
  /** The marker came back twice: not stored (F38 safety net). */
  | "not_filled"
  /** A 5xx answer or a thrown call. */
  | "error"
  /** No call: the page is not a cacheable public page. */
  | "skipped";

/** The visitor calls of one page of one hostname, or null. */
export async function selectWarmCalls(input: {
  target: WarmTarget;
  pathname: string;
  env: PublicCacheCallEnv;
}): Promise<{ html: PublicCacheCall; data: PublicCacheCall | null; saved: boolean } | null> {
  const { target } = input;
  const calls = await selectPublicCacheCalls({
    hostname: target.hostname,
    origin: `https://${target.hostname}`,
    pathname: toRequestPathname(input.pathname),
    resolution: target.resolution,
    env: input.env,
  });
  if (!calls) return null;
  return { html: calls.html, data: calls.data, saved: calls.delivery === "saved" };
}

/**
 * Fills one key. The body is cancelled after the headers: Workers Cache
 * still stores it (S2). A received probe marker means "not filled": retry
 * once (`fetchWithoutProbeMarker`).
 */
export async function fillCacheCall(
  exports: WarmCacheExports,
  call: PublicCacheCall,
): Promise<FillOutcome> {
  try {
    const response = await fetchWithoutProbeMarker(call.entrypoint, () =>
      fetchPublicCacheCall(exports, call),
    );
    if (!response) return "not_filled";
    await response.body?.cancel();
    return response.status >= 500 ? "error" : "filled";
  } catch {
    return "error";
  }
}

/**
 * After the last batch only (F41): is a key that this warmer filled stored
 * here? Never called before a fill (F38).
 */
export async function isCacheCallStored(
  exports: WarmCacheExports,
  call: PublicCacheCall,
): Promise<boolean> {
  const outcome = await probeCache(() =>
    fetchPublicCacheCall(exports, call, { probe: true }),
  );
  if (outcome.status === "hit") await outcome.response.body?.cancel();
  return outcome.status === "hit";
}

/** Runs `work` over `items` with at most `limit` in flight. */
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await work(item);
    }
  });
  await Promise.all(lanes);
  return results;
}
