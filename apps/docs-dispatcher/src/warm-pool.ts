import type { WarmPool } from "@doxahq/contracts/docs-warm-state";
import { warmPoolForLocation } from "@doxahq/contracts/docs-warm-region";

/**
 * The upper-tier pool that serves a visitor: the S1 colo table first, then a
 * geographic guess, else null. Null means "unknown": the visitor gets no
 * fallback and renders live. A wrong pool only makes a visitor see the
 * previous build a little longer, or render live a little earlier. The
 * table lives in `@doxahq/contracts/docs-warm-region`, shared with the warm
 * job and the API edge (M45).
 */
export function poolForRequest(cf: unknown): WarmPool | null {
  return warmPoolForLocation(cf);
}
