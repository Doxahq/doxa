import type { DocsWarmMessage, DocsWarmStatus } from "@doxahq/contracts/docs-warm-job";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";

import type { PublicCacheCallEnv } from "../public-cache-calls";
import type { DocsRuntimeRpc } from "../worker-exports";
import type { WarmConfigEnv } from "./warm-config";
import type { WarmJob, WarmOutcome } from "./warm-job";
import type { FillReservation, SubmitOutcome } from "./warm-lock-state";
import type { WarmNamespace } from "./warm-storage";

/**
 * The RPC surface of the four warm Durable Objects, as their callers see it.
 * Inputs and outputs are plain data: every object validates what it gets.
 */
export interface WarmLockRpc {
  submit(input: {
    message: DocsWarmMessage;
    target: string;
    pools: WarmPool[];
  }): Promise<{ outcome: SubmitOutcome }>;
  report(input: {
    siteId: string;
    jobId: string;
    pool: WarmPool;
    report: "running" | WarmOutcome;
  }): Promise<void>;
  heartbeat(input: { siteId: string; jobId: string }): Promise<{ current: boolean }>;
  reserveFills(input: { siteId: string; jobId: string; count: number }): Promise<FillReservation>;
  getStatus(input: { siteId: string }): Promise<DocsWarmStatus>;
}

export type AnchorStartResult =
  | { status: "started"; colo: string | null }
  | { status: "misplaced"; colo: string };

export interface WarmAnchorRpc {
  start(input: { job: WarmJob }): Promise<AnchorStartResult>;
}

export interface RegionalWarmerRpc {
  start(input: { job: WarmJob }): Promise<void>;
}

export interface WarmControlRpc {
  acquireSlot(input: {
    holder: string;
    siteId: string;
    max: number;
    maxPerSite: number;
  }): Promise<boolean>;
  releaseSlot(input: { holder: string }): Promise<void>;
  freeSlots(input: { max: number }): Promise<number>;
  sweepTick(input: { releaseId: string }): Promise<void>;
}

/** Bindings and vars of the warm job. All optional: without them it is off. */
export interface WarmEnv extends WarmConfigEnv, PublicCacheCallEnv {
  DOCS_RUNTIME: Pick<DocsRuntimeRpc, "request">;
  DOCS_HOSTNAME_MAP?: KVNamespace;
  DOCS_WARM_PUBLISH_QUEUE?: Queue<DocsWarmMessage>;
  DOCS_WARM_SWEEP_QUEUE?: Queue<DocsWarmMessage>;
  DOCS_WARM_LOCK?: WarmNamespace<WarmLockRpc>;
  DOCS_WARM_ANCHOR?: WarmNamespace<WarmAnchorRpc>;
  DOCS_REGIONAL_WARMER?: WarmNamespace<RegionalWarmerRpc>;
  DOCS_WARM_CONTROL?: WarmNamespace<WarmControlRpc>;
  /** A Doxa-owned hostname: the anchors read their colo from its trace. */
  DOXA_DOCS_BASE_DOMAIN?: string;
}
