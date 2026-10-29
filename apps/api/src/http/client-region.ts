import { CLIENT_REGION_HEADER } from "@doxahq/api-bridge";
import {
  isWarmPool,
  warmPoolForLocation,
} from "@doxahq/contracts/docs-warm-region";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";

/**
 * The caller's upper-tier cache pool (M45), or null when unknown.
 *
 * - As a Worker, Cloudflare sets `request.cf`, and only that is read: the
 *   header is never trusted there, because no edge strips it.
 * - On the Node origin there is no `request.cf`. The edge set the header from
 *   its own `request.cf`, and the origin's `asPublicRequest` dropped every
 *   client-sent copy before it re-set the edge's value
 *   (runtime/node/origin-handler.ts).
 */
export function readClientWarmPool(request: Request): WarmPool | null {
  const cf: unknown = Reflect.get(request, "cf");
  if (cf !== undefined && cf !== null) return warmPoolForLocation(cf);
  const header = request.headers.get(CLIENT_REGION_HEADER);
  return isWarmPool(header) ? header : null;
}
