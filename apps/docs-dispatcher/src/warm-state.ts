import {
  docsWarmStateKey,
  isWarmPoolDone,
  parseDocsWarmState,
  type WarmPool,
} from "@doxahq/contracts/docs-warm-state";

import type { HostnameMapStore } from "./hostname-map";

/** The warm job (WS5) writes `warm:{siteId}`; the dispatcher only reads it. */
export type WarmStateStore = Pick<HostnameMapStore, "get">;

/**
 * - `warm`: the record is for the deployed release and the pool is done.
 * - `cold`: the record is for the deployed release; the pool is not done.
 * - `stale`: the record is for another release.
 * - `missing`, `invalid`, `error`, `unbound`: no usable record.
 * Everything but `warm` means "not warm here".
 */
export type WarmStateStatus =
  | "warm"
  | "cold"
  | "stale"
  | "missing"
  | "invalid"
  | "error"
  | "unbound";

/** Never throws. A KV read can be ≈ 60 s old; that only extends a fallback. */
export async function readPoolWarmState(input: {
  store: WarmStateStore | undefined;
  siteId: string;
  releaseId: string;
  pool: WarmPool;
}): Promise<WarmStateStatus> {
  if (!input.store) return "unbound";
  let text: string | null;
  try {
    text = await input.store.get(docsWarmStateKey(input.siteId));
  } catch {
    return "error";
  }
  if (text === null) return "missing";
  const state = parseDocsWarmState(parseJson(text));
  if (!state) return "invalid";
  if (state.releaseId !== input.releaseId) return "stale";
  return isWarmPoolDone(state, input.releaseId, input.pool) ? "warm" : "cold";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
