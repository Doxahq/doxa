import {
  WARM_POOL_LOCATION_HINTS,
  warmPoolForColo,
} from "@doxahq/contracts/docs-warm-region";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";

import type { AnchorStartResult, WarmAnchorRpc } from "./warm-env";
import { anchorName, type WarmJob } from "./warm-job";
import { describeWarmError, logWarm } from "./warm-log";
import type { WarmNamespace, WarmStorage } from "./warm-storage";

/**
 * Pool anchors (spec § 7.1, F42). One Durable Object per pool, created with
 * the pool's location hint. Asia hints are not fixed places, so an anchor
 * checks its own colo once and refuses work when it sits in another pool;
 * the consumer then tries the next name (`anchor:{pool}:2`, …). A regional
 * warmer has no hint: the anchor creates it, so it lands in the anchor's
 * pool (first-caller placement, S1).
 */

/** Anchor names tried per pool before the pool counts as failed. */
export const MAX_ANCHOR_ATTEMPTS = 3;

const COLO_KEY = "colo";

export type AnchorPlacement = "placed" | "misplaced" | "unverified";

/** `placed` when the colo is in the pool's S1 table; `unverified` when unknown. */
export function placeAnchor(pool: WarmPool, colo: string | null): AnchorPlacement {
  if (!colo) return "unverified";
  const measured = warmPoolForColo(colo);
  if (measured === null) return "unverified";
  return measured === pool ? "placed" : "misplaced";
}

/** `colo=FRA` from a `/cdn-cgi/trace` body. */
export function parseTraceColo(text: string): string | null {
  const match = /^colo=([A-Z]{3})$/m.exec(text);
  return match?.[1] ?? null;
}

/**
 * The anchor's own colo, looked up once and stored. The lookup goes to a
 * Doxa-owned hostname only (`DOXA_DOCS_BASE_DOMAIN`), never to a customer's.
 */
export async function readAnchorColo(input: {
  storage: Pick<WarmStorage, "get" | "put">;
  baseDomain: string | undefined;
  fetchText(url: string): Promise<string>;
}): Promise<string | null> {
  const stored = await input.storage.get(COLO_KEY);
  if (typeof stored === "string") return stored;
  const domain = input.baseDomain?.trim();
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) return null;
  try {
    const colo = parseTraceColo(await input.fetchText(`https://${domain}/cdn-cgi/trace`));
    if (colo) await input.storage.put(COLO_KEY, colo);
    return colo;
  } catch {
    return null;
  }
}

/**
 * The consumer's side: start `job` on the first anchor of its pool that is
 * placed in the pool. Remembers per isolate which attempt worked.
 */
export async function startPoolOnAnchor(
  anchors: WarmNamespace<WarmAnchorRpc>,
  pool: WarmPool,
  job: WarmJob,
  memo: Map<WarmPool, number> = anchorMemo,
): Promise<"started" | "misplaced"> {
  for (let attempt = memo.get(pool) ?? 1; attempt <= MAX_ANCHOR_ATTEMPTS; attempt += 1) {
    const stub = anchors.get(anchors.idFromName(anchorName(pool, attempt)), {
      locationHint: WARM_POOL_LOCATION_HINTS[pool],
    });
    let result: AnchorStartResult;
    try {
      result = await stub.start({ job });
    } catch (error) {
      logWarm("docs_warm_anchor", {
        pool,
        attempt,
        outcome: "error",
        error: describeWarmError(error),
      });
      throw error;
    }
    if (result.status === "started") {
      memo.set(pool, attempt);
      return "started";
    }
  }
  return "misplaced";
}

const anchorMemo = new Map<WarmPool, number>();
