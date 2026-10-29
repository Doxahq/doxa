import type { DocsHostnameMapSync } from "@doxahq/contracts/docs-hostname-map";
import type { DocsWarmStatus } from "@doxahq/contracts/docs-warm-job";
import { z } from "zod";

import {
  HostnameMapWriteError,
  applyHostnameMapUpdates,
  lookupHostnameMapEntry,
  type HostnameMapLiveChange,
  type HostnameMapStore,
} from "../hostname-map";
import { toHostResolution } from "../host-resolution";
import { startPoolOnAnchor } from "./warm-anchor";
import { readWarmConfig } from "./warm-config";
import { processWarmMessage, type WarmConsumerDeps } from "./warm-consumer";
import type { WarmEnv } from "./warm-env";
import { WARM_SWEEP_NAME, siteLockName } from "./warm-job";
import { describeWarmError, logWarm } from "./warm-log";
import { readNavigationOrder, readWarmPlan } from "./warm-pages";
import { enqueuePublishWarm } from "./warm-trigger";

/**
 * The dispatcher's entry points into the warm job: the queue consumer, the
 * cron tick, the publish trigger inside `syncHostnames` and the status RPC.
 * Each builds its dependencies from the env and delegates to a pure module.
 */

const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface WarmQueueMessage {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Both warm queues. One message per batch (`max_batch_size: 1`). */
export async function handleWarmQueue(
  batch: { readonly messages: readonly WarmQueueMessage[] },
  env: WarmEnv,
): Promise<void> {
  const deps = createConsumerDeps(env);
  for (const message of batch.messages) {
    if (!deps) {
      logWarm("docs_warm_job", { outcome: "unbound", action: "ack" });
      message.ack();
      continue;
    }
    try {
      const decision = await processWarmMessage(message.body, message.attempts, deps);
      if (decision.action === "retry") {
        message.retry({ delaySeconds: decision.delaySeconds });
      } else {
        message.ack();
      }
    } catch {
      message.retry();
    }
  }
}

/** The 5-minute cron: one tick of the renderer-deploy sweep. */
export async function handleWarmSchedule(env: WarmEnv): Promise<void> {
  const config = readWarmConfig(env);
  const releaseId = env.DOXA_RENDERER_RELEASE_ID?.trim() ?? "";
  const control = env.DOCS_WARM_CONTROL;
  if (!config.deploySweep || config.rollout.mode === "off" || !control) return;
  if (!RELEASE_ID_PATTERN.test(releaseId)) return;
  await control.get(control.idFromName(WARM_SWEEP_NAME)).sweepTick({ releaseId });
}

/**
 * `DocsHostCache.syncHostnames`: writes the map, then sends one publish
 * message per site whose live version changed. The warm part never fails
 * the sync.
 */
export async function syncHostnamesWithWarm(
  store: HostnameMapStore,
  input: unknown,
  env: WarmEnv,
): Promise<void> {
  const config = readWarmConfig(env);
  if (config.rollout.mode === "off") {
    await applyHostnameMapUpdates(store, input);
    return;
  }
  const changes: HostnameMapLiveChange[] = [];
  const applied = await applyKeepingWrites(store, input, (change) => changes.push(change));
  const sync = applied.sync;
  const result = await enqueuePublishWarm({
    changes,
    hint: sync.warm,
    config,
    releaseId: env.DOXA_RENDERER_RELEASE_ID?.trim() ?? null,
    queue: env.DOCS_WARM_PUBLISH_QUEUE,
    createJobId: () => crypto.randomUUID(),
    now: Date.now(),
  });
  console.info(
    JSON.stringify({
      event: "docs_hostname_map_sync",
      updates: sync.updates.length,
      liveChanges: changes.length,
      warmHint: sync.warm !== undefined,
      ...result,
      ...(applied.failure ? { failedWrites: applied.failure.errors.length } : {}),
    }),
  );
  // The API retries the batch; the hostnames written above are warm already.
  if (applied.failure) throw applied.failure;
}

/**
 * Writes the map. When some writes failed, the warm job still starts for the
 * ones that were written (a retry sees them unchanged and would never warm
 * them, FC-L6); the caller rethrows the failure afterwards.
 */
async function applyKeepingWrites(
  store: HostnameMapStore,
  input: unknown,
  onLiveChange: (change: HostnameMapLiveChange) => void,
): Promise<{ sync: DocsHostnameMapSync; failure: HostnameMapWriteError | null }> {
  try {
    return { sync: await applyHostnameMapUpdates(store, input, { onLiveChange }), failure: null };
  } catch (error) {
    if (!(error instanceof HostnameMapWriteError)) throw error;
    return { sync: error.sync, failure: error };
  }
}

/**
 * Site IDs are database UUIDs (`siteIdSchema` in contracts). Anything else is
 * rejected before a lock stub exists, so a caller cannot create Durable
 * Objects under arbitrary names (FS-L3).
 */
const warmStatusInputSchema = z.object({ siteId: z.uuid() });

/** M45b: the site's warm progress; an empty status when nothing is bound. */
export async function readWarmStatus(env: WarmEnv, input: unknown): Promise<DocsWarmStatus> {
  const { siteId } = warmStatusInputSchema.parse(input);
  const locks = env.DOCS_WARM_LOCK;
  if (!locks) {
    return { siteId, releaseId: null, startedAt: null, finishedAt: null, pools: [] };
  }
  return locks.get(locks.idFromName(siteLockName(siteId))).getStatus({ siteId });
}

function createConsumerDeps(env: WarmEnv): WarmConsumerDeps | null {
  const locks = env.DOCS_WARM_LOCK;
  const anchors = env.DOCS_WARM_ANCHOR;
  if (!locks || !anchors || !env.DOCS_REGIONAL_WARMER || !env.DOCS_WARM_CONTROL) return null;
  const lockOf = (siteId: string) => locks.get(locks.idFromName(siteLockName(siteId)));
  return {
    config: readWarmConfig(env),
    deployedReleaseId: env.DOXA_RENDERER_RELEASE_ID?.trim() || null,
    now: () => Date.now(),
    readEntry: (hostname) => lookupHostnameMapEntry(env.DOCS_HOSTNAME_MAP, hostname, Date.now()),
    submit: async (input) => (await lockOf(input.message.siteId).submit(input)).outcome,
    reportPoolFailed: async (message, pool) => {
      try {
        await lockOf(message.siteId).report({
          siteId: message.siteId,
          jobId: message.jobId,
          pool,
          report: "failed",
        });
      } catch (error) {
        logWarm("docs_warm_lock", {
          siteId: message.siteId,
          jobId: message.jobId,
          pool,
          action: "report",
          state: "failed_to_report",
          error: describeWarmError(error),
        });
      }
    },
    readPlan: (target) => readWarmPlan(env.DOCS_RUNTIME, toHostResolution(target.resolution)),
    readNavigation: (target) =>
      readNavigationOrder(env.DOCS_RUNTIME, toHostResolution(target.resolution)),
    startPool: (pool, job) => startPoolOnAnchor(anchors, pool, job),
  };
}
