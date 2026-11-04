import {
  docsWarmMessageSchema,
  type DocsWarmMessage,
} from "@doxahq/contracts/docs-warm-job";
import { isStorableHostnameResolution } from "@doxahq/contracts/docs-hostname-map";
import { orderWarmPools } from "@doxahq/contracts/docs-warm-region";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";

import type { HostnameMapEntryLookup } from "../hostname-map";
import { isWarmSite, type WarmConfig } from "./warm-config";
import { createWarmTargetHash, type WarmJob, type WarmTarget } from "./warm-job";
import type { SubmitOutcome } from "./warm-lock-state";
import { describeWarmError, logWarm } from "./warm-log";
import { orderWarmPages } from "./warm-pages";

/**
 * The queue consumer of both warm queues (spec § 7.2 step 1). It trusts only
 * IDs from the message and re-reads every hostname from the hostname map. It
 * never fills a cache itself: a consumer runs in its own colo (F44); it
 * hands the job to each pool's anchor and acks.
 */

/** A delivery that does not see the message's version waits this long. */
export const KV_CATCH_UP_DELAY_SECONDS = 30;
/**
 * Deliveries that may wait for the hostname map to show the message's
 * version. With `max_retries: 5` a message has six deliveries; the last one
 * always uses what the map holds (F7).
 */
export const KV_CATCH_UP_MAX_ATTEMPTS = 5;

export type ConsumerDecision =
  | { action: "ack"; outcome: string }
  | { action: "retry"; delaySeconds: number; outcome: string };

export type PoolStart = "started" | "misplaced" | "failed";

export interface WarmConsumerDeps {
  config: WarmConfig;
  deployedReleaseId: string | null;
  now(): number;
  readEntry(hostname: string): Promise<HostnameMapEntryLookup>;
  submit(input: {
    message: DocsWarmMessage;
    target: string;
    pools: WarmPool[];
  }): Promise<SubmitOutcome>;
  reportPoolFailed(message: DocsWarmMessage, pool: WarmPool): Promise<void>;
  readPlan(target: WarmTarget): Promise<string[]>;
  readNavigation(target: WarmTarget): Promise<string[]>;
  startPool(pool: WarmPool, job: WarmJob): Promise<PoolStart>;
}

export async function processWarmMessage(
  body: unknown,
  attempts: number,
  deps: WarmConsumerDeps,
): Promise<ConsumerDecision> {
  const parsed = docsWarmMessageSchema.safeParse(body);
  if (!parsed.success) return ack("invalid_message");
  const message = parsed.data;
  let decision: ConsumerDecision;
  try {
    decision = await decide(message, attempts, deps);
  } catch (error) {
    logWarm("docs_warm_job", {
      ...messageFacts(message, attempts, deps.now()),
      outcome: "error",
      error: describeWarmError(error),
    });
    // The queue retries; the lock continues the same job ID.
    throw error;
  }
  logWarm("docs_warm_job", {
    ...messageFacts(message, attempts, deps.now()),
    action: decision.action,
    outcome: decision.outcome,
  });
  return decision;
}

async function decide(
  message: DocsWarmMessage,
  attempts: number,
  deps: WarmConsumerDeps,
): Promise<ConsumerDecision> {
  if (!isWarmSite(deps.config, message.siteId)) return ack("not_in_rollout");
  if (message.releaseId !== deps.deployedReleaseId) return ack("stale_release");

  const targets = await readLiveTargets(message, deps);
  const waitsForVersion =
    message.publishedVersionId !== undefined &&
    !targets.some(
      (target) => target.resolution.publishedVersionId === message.publishedVersionId,
    );
  if (waitsForVersion && attempts <= KV_CATCH_UP_MAX_ATTEMPTS) {
    return { action: "retry", delaySeconds: KV_CATCH_UP_DELAY_SECONDS, outcome: "kv_behind" };
  }
  const selected = targets.slice(0, deps.config.maxHostnames);
  const first = selected[0];
  if (!first) return ack("nothing_public");

  const pools = orderWarmPools(message.priority?.regions ?? [], deps.config.pools);
  const target = await createWarmTargetHash(selected, message.releaseId);
  const outcome = await deps.submit({ message, target, pools });
  if (outcome !== "granted" && outcome !== "continued") return ack(outcome);

  // One plan per job: the hostnames of a site share its published version.
  const [plan, navigation] = await Promise.all([
    deps.readPlan(first),
    deps.readNavigation(first),
  ]);
  const pages = orderWarmPages({
    plan,
    navigation,
    priorityPaths: message.priority?.paths ?? [],
    maxPages: deps.config.maxPages,
  });
  const startedAt = deps.now();
  const results = await Promise.all(
    pools.map(async (pool) => {
      const job: WarmJob = {
        jobId: message.jobId,
        siteId: message.siteId,
        reason: message.reason,
        releaseId: message.releaseId,
        pool,
        targets: selected,
        pages,
        startedAt,
      };
      const started = await deps.startPool(pool, job).catch((): PoolStart => "failed");
      if (started !== "started") await deps.reportPoolFailed(message, pool);
      return started;
    }),
  );
  const startedPools = results.filter((result) => result === "started").length;
  return ack(`${outcome}:${startedPools}/${pools.length}`);
}

/**
 * The message's hostnames as the map holds them now: only fresh public
 * production entries of this site. Another site's entry, a missing entry or
 * a preview is dropped (principle 4).
 */
async function readLiveTargets(
  message: DocsWarmMessage,
  deps: Pick<WarmConsumerDeps, "readEntry">,
): Promise<WarmTarget[]> {
  const hostnames = [...new Set(message.hostnames)];
  const lookups = await Promise.all(
    hostnames.map(async (hostname) => ({ hostname, lookup: await deps.readEntry(hostname) })),
  );
  return lookups.flatMap(({ hostname, lookup }) => {
    if (lookup.status !== "hit") return [];
    const { resolution, resolvedAt } = lookup.entry;
    if (
      resolution.siteId !== message.siteId ||
      !isStorableHostnameResolution(hostname, resolution) ||
      // A `doxa.page` hostname that redirects to the custom domain serves no
      // pages, so warming it would fill entries that nobody reads.
      resolution.canonicalHostname !== undefined
    ) {
      return [];
    }
    return [{ hostname: resolution.hostname, resolution, resolvedAt }];
  });
}

function ack(outcome: string): ConsumerDecision {
  return { action: "ack", outcome };
}

function messageFacts(message: DocsWarmMessage, attempts: number, now: number) {
  return {
    jobId: message.jobId,
    siteId: message.siteId,
    reason: message.reason,
    releaseId: message.releaseId,
    hostnames: message.hostnames.length,
    attempts,
    queuedMs: Math.max(0, now - message.enqueuedAt),
  };
}
